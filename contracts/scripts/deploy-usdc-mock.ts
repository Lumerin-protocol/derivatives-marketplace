import hre from "hardhat";
import { logTitle, logInfo, logSuccess } from "../lib/log.ts";
import { addrUrl } from "../lib/explorer.ts";
import { verifyContract } from "../lib/verify.ts";

async function main() {
  logTitle("USDCMock Deployment");

  const { viem } = await hre.network.connect();
  const [deployer] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  logInfo("deployer", { Address: addrUrl(pc, deployer.account.address) });

  console.log("Deploying USDCMock...");
  const usdcMock = await viem.deployContract("USDCMock");
  logInfo("USDCMock deployed", { Address: addrUrl(pc, usdcMock.address) });

  console.log("Verifying USDCMock...");
  await verifyContract(usdcMock.address, []);

  const [symbol, name, decimals, totalSupply] = await Promise.all([
    usdcMock.read.symbol(),
    usdcMock.read.name(),
    usdcMock.read.decimals(),
    usdcMock.read.totalSupply(),
  ]);

  logInfo("token", { Symbol: symbol, Name: name, Decimals: decimals, TotalSupply: totalSupply.toString() });
  logSuccess(addrUrl(pc, usdcMock.address));
}

main();
