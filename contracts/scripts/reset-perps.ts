import hre from "hardhat";
import { type Address, getAddress, isAddress, zeroAddress } from "viem";
import { requireEnvsSet } from "../lib/env.ts";
import { writeAndWait } from "../lib/writeContract.ts";
import { txUrl, addrUrl } from "../lib/explorer.ts";
import {
  logTitle,
  logInfo,
  logStep,
  logSuccess,
  logPrompt,
} from "../lib/log.ts";
import {
  DEFAULT_BLOCK_CHUNK,
  collectParticipants,
  fetchDeploymentBlockFromEtherscan,
  participantCachePath,
} from "./lib/participants.ts";

const DEFAULT_RESET_BATCH_SIZE = 25;

function readOptionalAddress(name: string): Address | undefined {
  const raw = process.env[name];
  if (!raw || raw === zeroAddress) return undefined;
  if (!isAddress(raw))
    throw new Error(`${name} is not a valid address: ${raw}`);
  return raw;
}

function readOptionalBigInt(name: string): bigint | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  return BigInt(raw);
}

function readResetBatchSize(): number {
  const raw = process.env.RESET_BATCH_SIZE;
  if (!raw) return DEFAULT_RESET_BATCH_SIZE;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("RESET_BATCH_SIZE must be a positive integer");
  }
  return value;
}

/**
 * Testnet migration helper: wipe the old perps venue and detach dead venues from
 * the shared collateral vault.
 *
 * 1. Discovers participants from onchain `OrderCreated`/`OrderMatched` logs, then,
 *    with the shared vault halted, calls `forceCancelOrders` and `forceClosePositions`
 *    in batches for the discovered list. Resumes the vault only if this run halted it.
 * 2. Optionally revokes the old perps (and, if `OLD_FUTURES_ADDRESS` is set, the
 *    old futures) as authorized callers on the vault so the retired contracts can
 *    no longer move collateral.
 *
 * Positions close at the mark against the insurance fund, so each user's balance
 * reflects their realized PnL and stays fully withdrawable/tradeable.
 */
async function main() {
  logTitle("HashPowerPerpsDEX Reset (testnet wipe)");

  const env = requireEnvsSet("PERPS_ADDRESS");
  const oldPerps = getAddress(env.PERPS_ADDRESS);
  const resetBatchSize = readResetBatchSize();
  const vaultAddress = readOptionalAddress("VAULT_ADDRESS");
  const oldFutures = readOptionalAddress("OLD_FUTURES_ADDRESS");

  const { viem } = await hre.network.connect();
  const [deployer] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  logInfo("deployer", { Address: addrUrl(pc, deployer.account.address) });

  const perps = await viem.getContractAt("HashPowerPerpsDEX", oldPerps);
  const perpsOwner = await perps.read.owner();
  if (getAddress(perpsOwner) !== getAddress(deployer.account.address)) {
    throw new Error(
      `Deployer ${deployer.account.address} is not the perps owner ${perpsOwner}`,
    );
  }

  const endBlock =
    readOptionalBigInt("END_BLOCK") ?? (await pc.getBlockNumber());
  const startBlockOverride = readOptionalBigInt("START_BLOCK");
  const startBlock =
    startBlockOverride ??
    (await fetchDeploymentBlockFromEtherscan(pc, oldPerps));
  const blockChunk =
    readOptionalBigInt("BLOCK_CHUNK_SIZE") ?? DEFAULT_BLOCK_CHUNK;

  logInfo("reset target", {
    Perps: addrUrl(pc, oldPerps),
    "Start block": `${startBlock}${startBlockOverride === undefined ? " (deployment block via Etherscan)" : ""}`,
    "End block": endBlock.toString(),
    "Block chunk": blockChunk.toString(),
    "Reset batch size": resetBatchSize,
    Vault: vaultAddress ? addrUrl(pc, vaultAddress) : "(skip de-authorize)",
    "Old futures": oldFutures ? addrUrl(pc, oldFutures) : "(none)",
    Cache:
      process.env.NO_CACHE === "true"
        ? "disabled (NO_CACHE)"
        : participantCachePath(pc, oldPerps),
  });

  // ── 1. Discover participants from onchain logs ────────────────────────────
  const participants = await collectParticipants(pc, oldPerps, {
    startBlock,
    endBlock,
    blockChunk,
  });

  logInfo("participants", {
    Total: participants.length,
    Sample: participants.slice(0, 5).join(", ") || "(none)",
  });

  if (participants.length === 0) {
    logSuccess("No participants found — nothing to reset.");
    return;
  }

  for (const participant of participants) console.log(`  ${participant}`);
  await logPrompt(
    `Cancel orders + close positions at the mark for ${participants.length} discovered participant(s). Proceed?`,
  );

  // ── 2. Cancel orders and close positions (vault halted) ───────────────────
  const venueVault = await viem.getContractAt(
    "CollateralVault",
    await perps.read.vault(),
  );
  const haltedHere = !(await venueVault.read.halted());
  if (haltedHere) {
    await logPrompt("Halt the shared vault (stops new orders on every venue)?");
    const haltReceipt = await writeAndWait(
      deployer,
      await venueVault.simulate.halt(),
    );
    logStep("halt vault", txUrl(pc, haltReceipt.transactionHash));
  }

  let lastResetBlock: bigint | undefined;
  for (let offset = 0; offset < participants.length; offset += resetBatchSize) {
    const batch = participants.slice(offset, offset + resetBatchSize);
    const range = `${offset + 1}-${offset + batch.length}`;
    const cancelReceipt = await writeAndWait(
      deployer,
      await perps.simulate.forceCancelOrders([batch]),
    );
    logStep(`forceCancelOrders ${range}`, txUrl(pc, cancelReceipt.transactionHash));
    const closeReceipt = await writeAndWait(
      deployer,
      await perps.simulate.forceClosePositions([batch]),
    );
    lastResetBlock = closeReceipt.blockNumber;
    logStep(`forceClosePositions ${range}`, txUrl(pc, closeReceipt.transactionHash));
  }
  if (lastResetBlock === undefined) {
    throw new Error("No reset transaction was submitted");
  }

  // Pin verification reads to the final reset block so a lagging RPC replica or
  // any activity after the wipe can't produce a false failure.
  const verifyAt = { blockNumber: lastResetBlock } as const;
  for (const participant of participants) {
    const [orderIds, position] = await Promise.all([
      perps.read.getUserOrders([participant], verifyAt),
      perps.read.getUserPosition([participant], verifyAt),
    ]);
    if (
      orderIds.length !== 0 ||
      position.netQuantity !== 0n ||
      position.netEntryValue !== 0n
    ) {
      throw new Error(
        `Participant reset verification failed for ${participant}: ` +
          `orders=${orderIds.length} netQuantity=${position.netQuantity} netEntryValue=${position.netEntryValue}`,
      );
    }
  }
  logStep(
    "verify participant state",
    `${participants.length} account(s) clear`,
  );

  if (haltedHere) {
    const resumeReceipt = await writeAndWait(
      deployer,
      await venueVault.simulate.resume(),
    );
    logStep("resume vault", txUrl(pc, resumeReceipt.transactionHash));
  }

  // ── 3. De-authorize dead venues on the vault (optional) ────────────────────
  if (vaultAddress) {
    const vault = await viem.getContractAt("CollateralVault", vaultAddress);
    const vaultOwner = await vault.read.owner();
    if (getAddress(vaultOwner) !== getAddress(deployer.account.address)) {
      throw new Error(
        `Deployer ${deployer.account.address} is not the vault owner ${vaultOwner}`,
      );
    }

    for (const dead of [oldPerps, oldFutures]) {
      if (!dead) continue;
      const authorized = await vault.read.authorizedCallers([dead]);
      if (!authorized) {
        logStep("de-authorize", `skipped ${dead} (already not authorized)`);
        continue;
      }
      logInfo("Vault.setAuthorizedCaller(false)", { caller: dead });
      await logPrompt("Proceed?");
      const sim = await vault.simulate.setAuthorizedCaller([dead, false]);
      const receipt = await writeAndWait(deployer, sim);
      logStep(`de-authorize ${dead}`, txUrl(pc, receipt.transactionHash));
    }
  }

  logSuccess(addrUrl(pc, oldPerps));
}

main();
