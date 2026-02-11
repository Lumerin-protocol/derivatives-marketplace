import { viem } from "hardhat";
import { logTitle, logInfo, logSuccess } from "../lib/log";
import { addrUrl } from "../lib/explorer";
import { verifyContract } from "../lib/verify";

async function main() {
  logTitle("USDCMock Deployment");

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
