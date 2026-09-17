import hre from "hardhat";
import {
  getAddress,
  getAbiItem,
  type Address,
  type PublicClient,
} from "viem";
import { HashPowerPerpsDEXAbi } from "../abi/HashPowerPerpsDEX.ts";
import { requireEnvsSet } from "../lib/env.ts";
import { txUrl, addrUrl } from "../lib/explorer.ts";
import { logInfo, logPrompt, logStep, logSuccess, logTitle } from "../lib/log.ts";
import { writeAndWait } from "../lib/writeContract.ts";

const READ_BATCH_SIZE = 25;
const DEFAULT_WRITE_BATCH_SIZE = 25;
const REBUILD_CONFIRMATIONS = 5;
const DAY = 24n * 60n * 60n;
const DEFAULT_EVENT_LOOKBACK_SECONDS = 180n * DAY;
const DEFAULT_EVENT_CHUNK_SIZE = 50_000n;
const ORDER_CREATED_EVENT = getAbiItem({
  abi: HashPowerPerpsDEXAbi,
  name: "OrderCreated",
});

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

async function resolveLookbackStartBlock(
  pc: PublicClient,
  latestBlock: bigint,
  lookbackSeconds: bigint,
): Promise<bigint> {
  const latest = await pc.getBlock({ blockNumber: latestBlock });
  const targetTimestamp =
    latest.timestamp > lookbackSeconds
      ? latest.timestamp - lookbackSeconds
      : 0n;
  let low = 0n;
  let high = latestBlock;
  while (low < high) {
    const mid = (low + high) / 2n;
    const block = await pc.getBlock({ blockNumber: mid });
    if (block.timestamp < targetTimestamp) low = mid + 1n;
    else high = mid;
  }
  return low;
}

async function discoverFromEvents(
  pc: PublicClient,
  perpsAddress: Address,
  latestBlock: bigint,
  startBlock: bigint,
): Promise<Set<Address>> {
  const addresses = new Set<Address>();
  let toBlock = latestBlock;
  let chunkSize = readPositiveBigInt("EVENT_SCAN_CHUNK_SIZE", DEFAULT_EVENT_CHUNK_SIZE);
  if (chunkSize === 0n) throw new Error("EVENT_SCAN_CHUNK_SIZE must be greater than zero");

  while (toBlock >= startBlock) {
    const desiredFrom = toBlock >= chunkSize - 1n ? toBlock - chunkSize + 1n : 0n;
    const fromBlock = desiredFrom > startBlock ? desiredFrom : startBlock;

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
      if (fromBlock === startBlock) break;
      toBlock = fromBlock - 1n;
    } catch (error) {
      if (chunkSize <= 100n) throw error;
      chunkSize /= 2n;
      console.warn(`Log query failed; retrying with ${chunkSize}-block chunks`);
    }
  }

  return addresses;
}

async function main() {
  logTitle("Rebuild Perps Order Aggregate Caches");

  const env = requireEnvsSet("PERPS_ADDRESS");
  const perpsAddress = getAddress(env.PERPS_ADDRESS);

  const { viem } = await hre.network.connect();
  const [deployer] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  const perps = await viem.getContractAt("HashPowerPerpsDEX", perpsAddress);
  const latestBlock = await pc.getBlockNumber();

  const owner = await perps.read.owner();
  if (getAddress(owner) !== getAddress(deployer.account.address)) {
    throw new Error(`Deployer ${deployer.account.address} is not the perps owner ${owner}`);
  }

  const lookbackSeconds = process.env.EVENT_LOOKBACK_DAYS
    ? readPositiveBigInt("EVENT_LOOKBACK_DAYS") * DAY
    : DEFAULT_EVENT_LOOKBACK_SECONDS;
  if (lookbackSeconds === 0n) {
    throw new Error("EVENT_LOOKBACK_DAYS must be greater than zero");
  }
  const startBlock = await resolveLookbackStartBlock(pc, latestBlock, lookbackSeconds);
  const discovered = await discoverFromEvents(
    pc,
    perpsAddress,
    latestBlock,
    startBlock,
  );

  // Event history includes users whose orders are already closed. Confirm every
  // candidate against proxy storage before rebuilding.
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
    Source: `OrderCreated events blocks ${startBlock}-${latestBlock}`,
    "Latest block": latestBlock,
    "Discovered participants": candidates.length,
    "Participants with open orders": activeUsers.length,
  });

  if (activeUsers.length === 0) {
    logSuccess("No active order aggregates require rebuilding");
    return;
  }

  for (const address of activeUsers) console.log(`  ${address}`);
  const writeBatchSize = Number(
    readPositiveBigInt("ORDER_CACHE_WRITE_BATCH_SIZE", BigInt(DEFAULT_WRITE_BATCH_SIZE)),
  );
  if (writeBatchSize === 0) {
    throw new Error("ORDER_CACHE_WRITE_BATCH_SIZE must be greater than zero");
  }
  await logPrompt(
    `Submit rebuildOrderAggregateCache in batches of ${writeBatchSize} account(s)?`,
  );

  for (let offset = 0; offset < activeUsers.length; offset += writeBatchSize) {
    const batch = activeUsers.slice(offset, offset + writeBatchSize);
    const simulation = await perps.simulate.rebuildOrderAggregateCache([batch]);
    const receipt = await writeAndWait(deployer, simulation, REBUILD_CONFIRMATIONS);
    logStep(
      `rebuildOrderAggregateCache ${offset + 1}-${offset + batch.length}`,
      txUrl(pc, receipt.transactionHash),
    );
  }

  const quantityDecimals = await perps.read.QUANTITY_DECIMALS();
  const scale = 10n ** BigInt(quantityDecimals);
  for (const user of activeUsers) {
    let buyQty = 0n;
    let sellQty = 0n;
    let buyValue = 0n;
    let sellValue = 0n;
    for (const id of await perps.read.getUserOrders([user])) {
      const order = await perps.read.getOrder([id]);
      if (order.quantity > 0n) {
        buyQty += order.quantity;
        buyValue += (order.price * order.quantity) / scale;
      } else if (order.quantity < 0n) {
        const absQty = -order.quantity;
        sellQty += absQty;
        sellValue += (order.price * absQty) / scale;
      }
    }
    const expected = { buyQty, sellQty, buyValue, sellValue };
    const actual = await perps.read.getOrderAggregate([user]);
    if (
      actual.buyQty !== expected.buyQty ||
      actual.sellQty !== expected.sellQty ||
      actual.buyValue !== expected.buyValue ||
      actual.sellValue !== expected.sellValue
    ) {
      throw new Error(
        `Verification failed for ${user}: ` +
          `cache=${Object.values(actual).join(",")} scan=${Object.values(expected).join(",")}`,
      );
    }
  }

  logSuccess(`${activeUsers.length} aggregate cache(s) rebuilt and verified`);
}

main();
