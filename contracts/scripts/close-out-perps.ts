import { network } from "hardhat";
import { type Address, type PublicClient, getAddress, parseAbi } from "viem";
import { requireEnvsSet } from "../lib/env.ts";
import { addrUrl, txUrl } from "../lib/explorer.ts";
import { logInfo, logPrompt, logStep, logSuccess, logTitle } from "../lib/log.ts";
import {
  DEFAULT_BLOCK_CHUNK,
  collectParticipants,
  fetchDeploymentBlockFromEtherscan,
} from "./lib/participants.ts";
import { chunk } from "./lib/resting-orders.ts";

// Closes out a retired 6.8.0 venue while the vault is halted: every position at the mark through
// the insurance fund, then every order. 6.8.0's `resetState` also deletes the position without
// paying its PnL, so it only runs once every position is flat. Dry run unless EXECUTE=true.
const RETIRED_VERSION = "6.8.0";
const RETIRED_PERPS_ABI = parseAbi([
  "function VERSION() view returns (string)",
  "function BACKSTOP() view returns (address)",
  "function getUserPosition(address) view returns ((int256 netQuantity, int256 netEntryValue))",
  "function getUserOrders(address) view returns (bytes32[])",
  "function forceClosePositions(address[])",
  "function resetState(address[])",
]);
const VAULT_ABI = parseAbi([
  "function halted() view returns (bool)",
  "function insuranceFundBalance() view returns (uint256)",
]);
const DEFAULT_BATCH_SIZE = 20;

type Holding = { user: Address; netQuantity: bigint; orders: number };

async function readHoldings(
  pc: PublicClient,
  perps: Address,
  users: readonly Address[],
  blockNumber: bigint,
): Promise<Holding[]> {
  return Promise.all(
    users.map(async (user) => {
      const [position, orders] = await Promise.all([
        pc.readContract({ address: perps, abi: RETIRED_PERPS_ABI, functionName: "getUserPosition", args: [user], blockNumber }),
        pc.readContract({ address: perps, abi: RETIRED_PERPS_ABI, functionName: "getUserOrders", args: [user], blockNumber }),
      ]);
      return { user, netQuantity: position.netQuantity, orders: orders.length };
    }),
  );
}

async function main() {
  logTitle("HashPowerPerpsDEX close-out");

  const env = requireEnvsSet("PERPS_ADDRESS", "VAULT_ADDRESS");
  const perps = getAddress(env.PERPS_ADDRESS);
  const vault = getAddress(env.VAULT_ADDRESS);
  const execute = process.env.EXECUTE === "true";
  const batchSize = Number(process.env.CLOSE_OUT_BATCH_SIZE ?? DEFAULT_BATCH_SIZE);

  const { viem } = await network.getOrCreate();
  const [deployer] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();

  const version = await pc.readContract({ address: perps, abi: RETIRED_PERPS_ABI, functionName: "VERSION" });
  if (version !== RETIRED_VERSION) {
    throw new Error(`Perps VERSION is ${version}; this script closes out ${RETIRED_VERSION}`);
  }
  const snapshot = await pc.getBlockNumber();
  if (!(await pc.readContract({ address: vault, abi: VAULT_ABI, functionName: "halted", blockNumber: snapshot }))) {
    throw new Error("The vault is not halted; run collateral-margin's vault-halt.ts first");
  }

  const startBlock = process.env.START_BLOCK
    ? BigInt(process.env.START_BLOCK)
    : await fetchDeploymentBlockFromEtherscan(pc, perps);
  const traders = await collectParticipants(pc, perps, {
    startBlock,
    endBlock: snapshot,
    blockChunk: DEFAULT_BLOCK_CHUNK,
  });
  // Liquidations hand positions to the backstop without an order event.
  const backstop = getAddress(
    await pc.readContract({ address: perps, abi: RETIRED_PERPS_ABI, functionName: "BACKSTOP" }),
  );
  const participants = [...new Set([...traders, backstop])];

  const holdings = await readHoldings(pc, perps, participants, snapshot);
  const open = holdings.filter((h) => h.netQuantity !== 0n);
  const withOrders = holdings.filter((h) => h.orders > 0);
  const fundBefore = await pc.readContract({ address: vault, abi: VAULT_ABI, functionName: "insuranceFundBalance" });
  logInfo("close-out plan", {
    Perps: addrUrl(pc, perps),
    "Snapshot block": snapshot,
    "Scanned from block": startBlock,
    Participants: participants.length,
    "Open positions": open.length,
    "Net long": open.reduce((s, h) => s + (h.netQuantity > 0n ? h.netQuantity : 0n), 0n),
    "Users with orders": withOrders.length,
    "Resting orders": withOrders.reduce((s, h) => s + h.orders, 0),
    "Insurance fund": fundBefore,
  });
  for (const h of open) logStep(h.user, `position ${h.netQuantity}, ${h.orders} order(s)`);

  if (!execute) {
    logSuccess("Dry run; set EXECUTE=true to send");
    return;
  }

  await logPrompt("Force-close the open positions, then reset the orders?");
  // A load-balanced RPC can report a head older than the receipts, so verify at the last receipt.
  let after = snapshot;
  for (const batch of chunk(open.map((h) => h.user), batchSize)) {
    const hash = await deployer.writeContract({ address: perps, abi: RETIRED_PERPS_ABI, functionName: "forceClosePositions", args: [batch] });
    const receipt = await pc.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`forceClosePositions reverted: ${txUrl(pc, hash)}`);
    after = receipt.blockNumber;
    logStep(`forceClosePositions(${batch.length})`, txUrl(pc, hash));
  }
  for (const batch of chunk(withOrders.map((h) => h.user), batchSize)) {
    const hash = await deployer.writeContract({ address: perps, abi: RETIRED_PERPS_ABI, functionName: "resetState", args: [batch] });
    const receipt = await pc.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`resetState reverted: ${txUrl(pc, hash)}`);
    after = receipt.blockNumber;
    logStep(`resetState(${batch.length})`, txUrl(pc, hash));
  }

  const left = (await readHoldings(pc, perps, participants, after)).filter((h) => h.netQuantity !== 0n || h.orders > 0);
  if (left.length > 0) throw new Error(`${left.length} participant(s) still hold a position or orders`);
  const fundAfter = await pc.readContract({ address: vault, abi: VAULT_ABI, functionName: "insuranceFundBalance", blockNumber: after });
  logInfo("closed out", {
    Block: after,
    "Insurance fund before": fundBefore,
    "Insurance fund after": fundAfter,
    "Paid by the fund": fundBefore - fundAfter,
  });
  logSuccess(`No positions or orders left on ${perps}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
