import { requireEnvsSet } from "../lib/env.ts";
import hre from "hardhat";
import { getAddress, isAddress } from "viem";
import { writeAndWait } from "../lib/writeContract.ts";
import { txUrl, addrUrl } from "../lib/explorer.ts";
import { logTitle, logInfo, logStep, logSuccess, logPrompt } from "../lib/log.ts";

/**
 * Toggle a vault authorized-caller flag.
 *
 * Env:
 *   VAULT_ADDRESS   — CollateralVault (required)
 *   CALLER_ADDRESS  — address to (de)authorize (required)
 *   AUTHORIZED      — "true" (default) or "false"
 */
async function main() {
  logTitle("CollateralVault setAuthorizedCaller");

  const env = requireEnvsSet("VAULT_ADDRESS", "CALLER_ADDRESS");
  const vaultAddress = getAddress(env.VAULT_ADDRESS);
  if (!isAddress(env.CALLER_ADDRESS)) {
    throw new Error(`CALLER_ADDRESS is not a valid address: ${env.CALLER_ADDRESS}`);
  }
  const caller = getAddress(env.CALLER_ADDRESS);
  const authorized = (process.env.AUTHORIZED ?? "true").toLowerCase() !== "false";

  const { viem } = await hre.network.connect();
  const [deployer] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  logInfo("deployer", { Address: addrUrl(pc, deployer.account.address) });

  const vault = await viem.getContractAt("CollateralVault", vaultAddress);
  const vaultOwner = await vault.read.owner();
  if (getAddress(vaultOwner) !== getAddress(deployer.account.address)) {
    throw new Error(`Deployer ${deployer.account.address} is not the vault owner ${vaultOwner}`);
  }

  const current = await vault.read.authorizedCallers([caller]);
  logInfo("setAuthorizedCaller", {
    Vault: addrUrl(pc, vaultAddress),
    Caller: caller,
    From: current,
    To: authorized,
  });

  if (current === authorized) {
    logSuccess(`No change — ${caller} already authorized=${authorized}`);
    return;
  }

  await logPrompt("Proceed?");
  const sim = await vault.simulate.setAuthorizedCaller([caller, authorized]);
  const receipt = await writeAndWait(deployer, sim);
  logStep("Done", txUrl(pc, receipt.transactionHash));
  logSuccess(`${caller} authorized=${authorized}`);
}

main();
