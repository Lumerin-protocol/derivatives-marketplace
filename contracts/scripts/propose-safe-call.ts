import { OperationType } from "@safe-global/types-kit";
import { network } from "hardhat";
import { type Hex, getAddress, isAddress, isHex } from "viem";
import { requireEnvsSet } from "../lib/env.ts";
import { logInfo, logPrompt, logStep, logSuccess, logTitle } from "../lib/log.ts";
import { SafeWallet } from "../lib/safe.ts";

/**
 * Propose one call to the owner Safe, for scripts that only print Safe calldata
 * (collateral-margin vault, engine and points calls). Simulates it as the Safe first.
 * Dry run unless EXECUTE=true.
 *
 * Env:
 *   SAFE_OWNER_ADDRESS — the Safe (required)
 *   SAFE_TX_TO         — call target (required)
 *   SAFE_TX_DATA       — calldata (required)
 */
async function main() {
  logTitle("Propose Safe call");

  const env = requireEnvsSet("SAFE_OWNER_ADDRESS", "SAFE_API_KEY", "SAFE_TX_TO", "SAFE_TX_DATA");
  if (!isAddress(env.SAFE_TX_TO)) throw new Error(`SAFE_TX_TO is not valid: ${env.SAFE_TX_TO}`);
  if (!isHex(env.SAFE_TX_DATA) || env.SAFE_TX_DATA.length < 10) {
    throw new Error(`SAFE_TX_DATA is not calldata: ${env.SAFE_TX_DATA}`);
  }
  const safeAddress = getAddress(env.SAFE_OWNER_ADDRESS);
  const to = getAddress(env.SAFE_TX_TO);
  const data = env.SAFE_TX_DATA as Hex;

  const { viem } = await network.connect();
  const [deployer] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();

  logInfo("call", { Safe: safeAddress, To: to, Data: data, Proposer: deployer.account.address });
  // SKIP_SIMULATION=true: for a call that depends on an earlier queued Safe transaction; simulate the sequence on a fork.
  if (process.env.SKIP_SIMULATION === "true") {
    logStep("simulation", "skipped");
  } else {
    await pc.call({ account: safeAddress, to, data });
    logStep("simulation", "succeeds as the Safe");
  }
  if (process.env.EXECUTE !== "true") {
    logSuccess("Dry run; set EXECUTE=true to propose");
    return;
  }

  await logPrompt(`Propose this call to Safe ${safeAddress}?`);
  const safe = new SafeWallet(safeAddress, deployer, env.SAFE_API_KEY);
  const safeTxHash = await safe.proposeTransaction({ to, value: "0", data, operation: OperationType.Call });
  logStep("Safe UI URL", safe.getSafeUITxUrl(safeTxHash));
  logSuccess(`Proposed ${safeTxHash}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
