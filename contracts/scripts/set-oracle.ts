import { getAddress, isAddress } from "viem";
import { requireEnvsSet } from "../lib/env.ts";
import { network } from "hardhat";
import { writeAndWait } from "../lib/writeContract.ts";
import { txUrl, addrUrl } from "../lib/explorer.ts";
import { logTitle, logInfo, logStep, logSuccess, logPrompt } from "../lib/log.ts";

/**
 * Point HashPowerPerpsDEX at a new Chainlink-style hashprice oracle.
 *
 * Env:
 *   PERPS_ADDRESS          — venue proxy (required)
 *   HASHPRICE_USD_ADDRESS  — new AggregatorV3 oracle (required)
 */
async function main() {
  logTitle("HashPowerPerpsDEX setOracle");

  const env = requireEnvsSet("PERPS_ADDRESS");
  const oracleRaw = process.env.HASHPRICE_USD_ADDRESS ?? process.env.PRICE_ORACLE_ADDRESS;
  if (!oracleRaw) {
    throw new Error("HASHPRICE_USD_ADDRESS or PRICE_ORACLE_ADDRESS is required");
  }
  if (!isAddress(oracleRaw)) {
    throw new Error(`Oracle address is not valid: ${oracleRaw}`);
  }

  const proxyAddress = getAddress(env.PERPS_ADDRESS);
  const oracleAddress = getAddress(oracleRaw);

  const { viem } = await network.connect();
  const [deployer] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  logInfo("deployer", { Address: addrUrl(pc, deployer.account.address) });

  const perps = await viem.getContractAt("HashPowerPerpsDEX", proxyAddress);
  const owner = await perps.read.owner();
  if (getAddress(owner) !== getAddress(deployer.account.address)) {
    throw new Error(`Deployer ${deployer.account.address} is not the proxy owner ${owner}`);
  }

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

  await logPrompt("Proceed?");
  const sim = await perps.simulate.setOracle([oracleAddress]);
  const receipt = await writeAndWait(deployer, sim);
  logStep("Done", txUrl(pc, receipt.transactionHash));
  logSuccess(`priceOracle → ${oracleAddress}`);
}

main();
