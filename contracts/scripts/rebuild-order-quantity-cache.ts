import hre from "hardhat";
import {
  getAddress,
  parseAbiItem,
  type Address,
  type PublicClient,
} from "viem";
import { requireEnvsSet } from "../lib/env.ts";
import { txUrl, addrUrl } from "../lib/explorer.ts";
import { logInfo, logPrompt, logStep, logSuccess, logTitle } from "../lib/log.ts";
import { writeAndWait } from "../lib/writeContract.ts";

const PAGE_SIZE = 1_000;
const READ_BATCH_SIZE = 25;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ORDER_CREATED_EVENT = parseAbiItem(
  "event OrderCreated(bytes32 indexed orderId, address indexed participant, uint256 price, int256 quantity)",
);

type DiscoverySource = "auto" | "indexer" | "events";

type IndexerResponse = {
  data?: {
    _meta: {
      block: { number: number };
      hasIndexingErrors: boolean;
    };
    users: Array<{
      id: string;
      address: string;
      activeOrderCount: number;
    }>;
  };
  errors?: Array<{ message: string }>;
};

function readPositiveBigInt(name: string, fallback?: bigint): bigint {
  const raw = process.env[name];
  if (!raw) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Environment variable ${name} is required`);
  }

  const value = BigInt(raw);
  if (value < 0n) throw new Error(`${name} must not be negative`);
  return value;
}

function readSource(): DiscoverySource {
  const source = process.env.ORDER_CACHE_DISCOVERY_SOURCE ?? "auto";
  if (source !== "auto" && source !== "indexer" && source !== "events") {
    throw new Error("ORDER_CACHE_DISCOVERY_SOURCE must be auto, indexer, or events");
  }
  return source;
}

async function discoverFromIndexer(
  url: string,
  latestBlock: bigint,
): Promise<{ addresses: Set<Address>; indexedBlock: bigint }> {
  const addresses = new Set<Address>();
  let lastId = ZERO_ADDRESS;
  let indexedBlock = 0n;

  for (;;) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `
          query ActiveUsers($lastId: Bytes!, $first: Int!) {
            _meta {
              block { number }
              hasIndexingErrors
            }
            users(
              first: $first
              orderBy: id
              orderDirection: asc
              where: { activeOrderCount_gt: 0, id_gt: $lastId }
            ) {
              id
              address
              activeOrderCount
            }
          }
        `,
        variables: { lastId, first: PAGE_SIZE },
      }),
    });

    if (!response.ok) {
      throw new Error(`Indexer returned HTTP ${response.status}: ${await response.text()}`);
    }

    const payload = (await response.json()) as IndexerResponse;
    if (payload.errors?.length) {
      throw new Error(payload.errors.map((error) => error.message).join("; "));
    }
    if (!payload.data) throw new Error("Indexer response did not contain data");
    if (payload.data._meta.hasIndexingErrors) throw new Error("Indexer reports indexing errors");

    indexedBlock = BigInt(payload.data._meta.block.number);
    for (const user of payload.data.users) {
      addresses.add(getAddress(user.address));
    }

    if (payload.data.users.length < PAGE_SIZE) break;
    lastId = payload.data.users[payload.data.users.length - 1].id;
  }

  const maxLag = readPositiveBigInt("MAX_INDEXER_LAG_BLOCKS", 50n);
  const lag = latestBlock > indexedBlock ? latestBlock - indexedBlock : 0n;
  if (lag > maxLag) {
    throw new Error(`Indexer is ${lag} blocks behind; maximum allowed lag is ${maxLag}`);
  }

  return { addresses, indexedBlock };
}

async function discoverFromEvents(
  pc: PublicClient,
  perpsAddress: Address,
  latestBlock: bigint,
): Promise<Set<Address>> {
  const addresses = new Set<Address>();
  let fromBlock = readPositiveBigInt("PERPS_START_BLOCK");
  let chunkSize = readPositiveBigInt("EVENT_SCAN_CHUNK_SIZE", 5_000n);
  if (chunkSize === 0n) throw new Error("EVENT_SCAN_CHUNK_SIZE must be greater than zero");

  while (fromBlock <= latestBlock) {
    const toBlock =
      fromBlock + chunkSize - 1n < latestBlock ? fromBlock + chunkSize - 1n : latestBlock;

    try {
      const logs = await pc.getLogs({
        address: perpsAddress,
        event: ORDER_CREATED_EVENT,
        fromBlock,
        toBlock,
      });
      for (const log of logs) {
        if (log.args.participant) addresses.add(getAddress(log.args.participant));
      }
      logStep(`scan ${fromBlock}-${toBlock}`, `${addresses.size} participant(s)`);
      fromBlock = toBlock + 1n;
    } catch (error) {
      if (chunkSize <= 100n) throw error;
      chunkSize /= 2n;
      console.warn(`Log query failed; retrying with ${chunkSize}-block chunks`);
    }
  }

  return addresses;
}

async function main() {
  logTitle("Rebuild Perps Order Quantity Caches");

  const env = requireEnvsSet("PERPS_ADDRESS");
  const perpsAddress = getAddress(env.PERPS_ADDRESS);
  const source = readSource();
  const indexerUrl = process.env.PERPS_INDEXER_URL ?? process.env.SUBGRAPH_URL;

  const { viem } = await hre.network.connect();
  const [deployer] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  const perps = await viem.getContractAt("HashPowerPerpsDEX", perpsAddress);
  const latestBlock = await pc.getBlockNumber();

  const owner = await perps.read.owner();
  if (getAddress(owner) !== getAddress(deployer.account.address)) {
    throw new Error(`Deployer ${deployer.account.address} is not the perps owner ${owner}`);
  }

  let discovered: Set<Address>;
  let usedSource: "indexer" | "events";

  if (source !== "events" && indexerUrl) {
    try {
      const result = await discoverFromIndexer(indexerUrl, latestBlock);
      discovered = result.addresses;
      usedSource = "indexer";
      logStep("indexer block", result.indexedBlock.toString());
    } catch (error) {
      if (source === "indexer") throw error;
      console.warn(`Indexer discovery failed: ${(error as Error).message}`);
      console.warn("Falling back to OrderCreated event scan");
      discovered = await discoverFromEvents(pc, perpsAddress, latestBlock);
      usedSource = "events";
    }
  } else {
    if (source === "indexer") {
      throw new Error("PERPS_INDEXER_URL or SUBGRAPH_URL is required for indexer discovery");
    }
    discovered = await discoverFromEvents(pc, perpsAddress, latestBlock);
    usedSource = "events";
  }

  // Event history includes users whose orders are already closed, and an indexer
  // may be a few blocks behind. Confirm every candidate against proxy storage.
  const candidates = [...discovered].sort();
  const activeUsers: Address[] = [];
  for (let offset = 0; offset < candidates.length; offset += READ_BATCH_SIZE) {
    const batch = candidates.slice(offset, offset + READ_BATCH_SIZE);
    const orders = await Promise.all(
      batch.map((address) => perps.read.getUserOrders([address])),
    );
    for (let i = 0; i < batch.length; i++) {
      if (orders[i].length > 0) activeUsers.push(batch[i]);
    }
  }

  logInfo("migration", {
    Perps: addrUrl(pc, perpsAddress),
    Owner: addrUrl(pc, owner),
    Source: usedSource,
    "Latest block": latestBlock,
    "Discovered participants": candidates.length,
    "Participants with open orders": activeUsers.length,
  });

  if (activeUsers.length === 0) {
    logSuccess("No active order caches require rebuilding");
    return;
  }

  for (const address of activeUsers) console.log(`  ${address}`);
  await logPrompt("Submit one rebuildOrderQuantityCache transaction for these accounts?");

  const simulation = await perps.simulate.rebuildOrderQuantityCache([activeUsers]);
  const receipt = await writeAndWait(deployer, simulation);
  logStep("rebuildOrderQuantityCache", txUrl(pc, receipt.transactionHash));
  logSuccess(`${activeUsers.length} cache(s) rebuilt`);
}

main();
