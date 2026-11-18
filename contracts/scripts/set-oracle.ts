import { OperationType } from "@safe-global/types-kit";
import { encodeFunctionData, getAddress, isAddress } from "viem";
import { requireEnvsSet } from "../lib/env.ts";
import { network } from "hardhat";
import { SafeWallet } from "../lib/safe.ts";
import { writeAndWait } from "../lib/writeContract.ts";
import { txUrl, addrUrl } from "../lib/explorer.ts";
import { logTitle, logInfo, logStep, logSuccess, logPrompt } from "../lib/log.ts";

/**
 * Point HashPowerPerpsDEX at the feed it marks against.
 *
 * Env:
 *   PERPS_ADDRESS        — venue proxy (required)
 *   MARK_ORACLE_ADDRESS  — `HashpriceGlideUSD`, as on futures (required)
 *   SAFE_OWNER_ADDRESS   — the owner Safe, when the deployer is not the owner; the call is proposed to it
 */
async function main() {
  logTitle("HashPowerPerpsDEX setOracle");

  const env = requireEnvsSet("PERPS_ADDRESS", "MARK_ORACLE_ADDRESS");
  if (!isAddress(env.MARK_ORACLE_ADDRESS)) {
    throw new Error(`MARK_ORACLE_ADDRESS is not valid: ${env.MARK_ORACLE_ADDRESS}`);
  }

  const proxyAddress = getAddress(env.PERPS_ADDRESS);
  const oracleAddress = getAddress(env.MARK_ORACLE_ADDRESS);

  const { viem } = await network.connect();
  const [deployer] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  logInfo("deployer", { Address: addrUrl(pc, deployer.account.address) });

  const perps = await viem.getContractAt("HashPowerPerpsDEX", proxyAddress);
  const owner = getAddress(await perps.read.owner());
  const deployerIsOwner = owner === getAddress(deployer.account.address);

  const current = await perps.read.priceOracle();
  const version = await perps.read.VERSION().catch(() => "unknown");
  logInfo("setOracle", {
    Perps: addrUrl(pc, proxyAddress),
    Version: version,
    From: addrUrl(pc, current),
    To: addrUrl(pc, oracleAddress),
  });

  if (getAddress(current) === oracleAddress) {
    logSuccess("No change — oracle already set");
    return;
  }

  if (!deployerIsOwner) {
    const { SAFE_OWNER_ADDRESS, SAFE_API_KEY } = requireEnvsSet("SAFE_OWNER_ADDRESS", "SAFE_API_KEY");
    if (getAddress(SAFE_OWNER_ADDRESS) !== owner) {
      throw new Error(`SAFE_OWNER_ADDRESS ${SAFE_OWNER_ADDRESS} is not the proxy owner ${owner}`);
    }
    await perps.simulate.setOracle([oracleAddress], { account: owner });
    await logPrompt(`Propose setOracle to Safe ${owner}?`);
    const safe = new SafeWallet(owner, deployer, SAFE_API_KEY);
    const safeTxHash = await safe.proposeTransaction({
      to: proxyAddress,
      value: "0",
      data: encodeFunctionData({ abi: perps.abi, functionName: "setOracle", args: [oracleAddress] }),
      operation: OperationType.Call,
    });
    logStep("Safe UI URL", safe.getSafeUITxUrl(safeTxHash));
    logSuccess(`Proposed priceOracle → ${oracleAddress}`);
    return;
  }

  await logPrompt("Proceed?");
  const sim = await perps.simulate.setOracle([oracleAddress]);
  const receipt = await writeAndWait(deployer, sim);
  logStep("Done", txUrl(pc, receipt.transactionHash));
  logSuccess(`priceOracle → ${oracleAddress}`);
}

main();
