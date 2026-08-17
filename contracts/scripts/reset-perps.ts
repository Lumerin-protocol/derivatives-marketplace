import { requireEnvsSet } from "../lib/env.ts";
import hre from "hardhat";
import { type Address, getAddress, isAddress, zeroAddress } from "viem";
import { writeAndWait } from "../lib/writeContract.ts";
import { txUrl, addrUrl } from "../lib/explorer.ts";
import { logTitle, logInfo, logStep, logSuccess, logPrompt } from "../lib/log.ts";

const DEFAULT_RESET_BATCH_SIZE = 25;

function readOptionalAddress(name: string): Address | undefined {
  const raw = process.env[name];
  if (!raw || raw === zeroAddress) return undefined;
  if (!isAddress(raw)) throw new Error(`${name} is not a valid address: ${raw}`);
  return raw;
}

function readParticipants(raw: string): Address[] {
  const participants = new Map<string, Address>();
  for (const value of raw.split(",")) {
    const candidate = value.trim();
    if (!candidate) continue;
    if (!isAddress(candidate)) {
      throw new Error(`RESET_PARTICIPANTS contains an invalid address: ${candidate}`);
    }
    const address = getAddress(candidate);
    participants.set(address.toLowerCase(), address);
  }
  if (participants.size === 0) {
    throw new Error("RESET_PARTICIPANTS must contain at least one address");
  }
  return [...participants.values()];
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
 * 1. Calls `resetState(address[])` in batches for the explicit,
 *    operator-supplied participant list.
 * 2. Optionally revokes the old perps (and, if `OLD_FUTURES_ADDRESS` is set, the
 *    old futures) as authorized callers on the vault so the retired contracts can
 *    no longer move collateral.
 *
 * User deposits in the vault are untouched — once positions are wiped each user's
 * portfolio IM drops to zero, so balances remain fully withdrawable/tradeable.
 */
async function main() {
  logTitle("HashPowerPerpsDEX Reset (testnet wipe)");

  const env = requireEnvsSet("PERPS_ADDRESS", "RESET_PARTICIPANTS");
  const oldPerps = getAddress(env.PERPS_ADDRESS);
  const participants = readParticipants(env.RESET_PARTICIPANTS);
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
    throw new Error(`Deployer ${deployer.account.address} is not the perps owner ${perpsOwner}`);
  }

  logInfo("reset target", {
    Perps: addrUrl(pc, oldPerps),
    Participants: participants.length,
    "Reset batch size": resetBatchSize,
    Vault: vaultAddress ? addrUrl(pc, vaultAddress) : "(skip de-authorize)",
    "Old futures": oldFutures ? addrUrl(pc, oldFutures) : "(none)",
  });

  for (const participant of participants) console.log(`  ${participant}`);
  await logPrompt("Clear orders + positions for ONLY the listed participants. Proceed?");

  // ── 1. Wipe perps state ───────────────────────────────────────────────────
  for (let offset = 0; offset < participants.length; offset += resetBatchSize) {
    const batch = participants.slice(offset, offset + resetBatchSize);
    const resetRes = await perps.simulate.resetState([batch]);
    const resetReceipt = await writeAndWait(deployer, resetRes);
    logStep(
      `resetState ${offset + 1}-${offset + batch.length}`,
      txUrl(pc, resetReceipt.transactionHash),
    );
  }
  for (const participant of participants) {
    const [orderIds, position] = await Promise.all([
      perps.read.getUserOrders([participant]),
      perps.read.getUserPosition([participant]),
    ]);
    if (orderIds.length !== 0 || position.netQuantity !== 0n || position.netEntryValue !== 0n) {
      throw new Error(`Participant reset verification failed for ${participant}`);
    }
  }
  logStep("verify participant state", `${participants.length} account(s) clear`);

  // ── 2. De-authorize dead venues on the vault (optional) ────────────────────
  if (vaultAddress) {
    const vault = await viem.getContractAt("CollateralVault", vaultAddress);
    const vaultOwner = await vault.read.owner();
    if (getAddress(vaultOwner) !== getAddress(deployer.account.address)) {
      throw new Error(`Deployer ${deployer.account.address} is not the vault owner ${vaultOwner}`);
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
