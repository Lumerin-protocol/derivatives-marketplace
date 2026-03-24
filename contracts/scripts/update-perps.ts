import { requireEnvsSet } from "../lib/env.ts";
import { network } from "hardhat";
import { writeAndWait } from "../lib/writeContract.ts";
import { verifyContract } from "../lib/verify.ts";
import { txUrl, addrUrl } from "../lib/explorer.ts";
import { logTitle, logInfo, logStep, logSuccess, logPrompt } from "../lib/log.ts";

async function main() {
  logTitle("HashPowerPerpsDEX Upgrade");

  const env = requireEnvsSet("PERPS_ADDRESS", "MINIMUM_PRICE_INCREMENT");

  const proxyAddress = env.PERPS_ADDRESS as `0x${string}`;

  const { viem } = await network.connect();
  const [deployer] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  logInfo("deployer", { Address: addrUrl(pc, deployer.account.address) });

  // Get current proxy contract
  const perps = await viem.getContractAt("HashPowerPerpsDEX", proxyAddress);
  const currentOwner = await perps.read.owner();
  logInfo("proxy", {
    Address: addrUrl(pc, proxyAddress),
    Owner: currentOwner,
  });

  if (currentOwner.toLowerCase() !== deployer.account.address.toLowerCase()) {
    throw new Error(`Deployer ${deployer.account.address} is not the proxy owner ${currentOwner}`);
  }

  await logPrompt("Review the configuration above. Proceed with upgrade?");

  console.log();

  // Deploy new HashPowerPerpsDEX implementation
  logInfo("Deploy new HashPowerPerpsDEX implementation", {
    contract: "HashPowerPerpsDEX",
    args: `minimumPriceIncrement=${env.MINIMUM_PRICE_INCREMENT}`,
  });
  await logPrompt("Proceed?");
  console.log("Deploying new implementation...");
  const newImpl = await viem.deployContract("contracts/HashPowerPerpsDEX.sol:HashPowerPerpsDEX", [
    BigInt(env.MINIMUM_PRICE_INCREMENT),
  ]);
  logStep("Deployed", addrUrl(pc, newImpl.address));

  console.log("Verifying new implementation...");
  await verifyContract(newImpl.address, [env.MINIMUM_PRICE_INCREMENT]);
  logStep("Verified", addrUrl(pc, newImpl.address));

  // Upgrade proxy to new implementation
  logInfo("Upgrade proxy", {
    Proxy: addrUrl(pc, proxyAddress),
    "New implementation": addrUrl(pc, newImpl.address),
  });
  await logPrompt("Proceed with upgradeToAndCall?");
  console.log("Upgrading proxy...");
  const upgradeRes = await perps.simulate.upgradeToAndCall([newImpl.address, "0x"]);
  const upgradeReceipt = await writeAndWait(deployer, upgradeRes);
  logStep("Upgraded", txUrl(pc, upgradeReceipt.transactionHash));

  logSuccess(addrUrl(pc, proxyAddress));
}

main();
