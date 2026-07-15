import { requireEnvsSet } from "../lib/env.ts";
import hre from "hardhat";
import { type Address, getAddress, isAddress, zeroAddress } from "viem";
import { writeAndWait } from "../lib/writeContract.ts";
import { txUrl, addrUrl } from "../lib/explorer.ts";
import { logTitle, logInfo, logStep, logSuccess, logPrompt } from "../lib/log.ts";

function readOptionalAddress(name: string): Address | undefined {
  const raw = process.env[name];
  if (!raw || raw === zeroAddress) return undefined;
  if (!isAddress(raw)) throw new Error(`${name} is not a valid address: ${raw}`);
  return raw;
}

/**
 * Testnet migration helper: wipe the old perps venue and detach dead venues from
 * the shared collateral vault.
 *
 * 1. Calls `resetState()` on the old perps DEX — clears every order, price level,
 *    and position in one owner-only tx.
 * 2. Optionally revokes the old perps (and, if `OLD_FUTURES_ADDRESS` is set, the
 *    old futures) as authorized callers on the vault so the retired contracts can
 *    no longer move collateral.
 *
 * User deposits in the vault are untouched — once positions are wiped each user's
 * portfolio IM drops to zero, so balances remain fully withdrawable/tradeable.
 */
async function main() {
  logTitle("HashPowerPerpsDEX Reset (testnet wipe)");

  const env = requireEnvsSet("PERPS_ADDRESS");
  const oldPerps = getAddress(env.PERPS_ADDRESS);
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
    Vault: vaultAddress ? addrUrl(pc, vaultAddress) : "(skip de-authorize)",
    "Old futures": oldFutures ? addrUrl(pc, oldFutures) : "(none)",
  });

  await logPrompt("This wipes ALL perps orders + positions. Proceed?");

  // ── 1. Wipe perps state ───────────────────────────────────────────────────
  console.log("Calling resetState()...");
  const resetRes = await perps.simulate.resetState();
  const resetReceipt = await writeAndWait(deployer, resetRes);
  logStep("resetState", txUrl(pc, resetReceipt.transactionHash));

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
