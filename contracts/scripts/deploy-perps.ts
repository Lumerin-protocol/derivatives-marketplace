import fs from "node:fs";
import { requireEnvsSet } from "../lib/env.ts";
import hre from "hardhat";
import { encodeFunctionData } from "viem";
import { writeAndWait } from "../lib/writeContract.ts";
import { verifyContract } from "../lib/verify.ts";
import { txUrl, addrUrl } from "../lib/explorer.ts";
import { logTitle, logInfo, logStep, logSuccess, logPrompt } from "../lib/log.ts";

async function main() {
  logTitle("HashPowerPerpsDEX Deployment");
  const { viem } = await hre.network.connect();

  const env = requireEnvsSet(
    "COLLATERAL_TOKEN_ADDRESS",
    "PRICE_ORACLE_ADDRESS",
    "MARGIN_PERCENT",
    "MAINTENANCE_MARGIN_PERCENT",
    "TAKER_FEE_BPS",
    "MAKER_FEE_BPS",
    "LIQUIDATION_FEE",
    "MINIMUM_PRICE_INCREMENT",
  );
  const SAFE_OWNER_ADDRESS = process.env.SAFE_OWNER_ADDRESS;

  const [deployer] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  logInfo("deployer", { Address: addrUrl(pc, deployer.account.address) });

  // Verify collateral token
  const collateralToken = await viem.getContractAt(
    "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol:IERC20Metadata",
    env.COLLATERAL_TOKEN_ADDRESS as `0x${string}`,
  );
  logInfo("collateral", {
    Address: collateralToken.address,
    Symbol: await collateralToken.read.symbol(),
    Name: await collateralToken.read.name(),
    Decimals: await collateralToken.read.decimals(),
  });

  // Verify price oracle
  const priceOracle = await viem.getContractAt(
    "contracts/AggregatorV3Interface.sol:AggregatorV3Interface",
    env.PRICE_ORACLE_ADDRESS as `0x${string}`,
  );
  const [, answer, , updatedAt] = await priceOracle.read.latestRoundData();
  logInfo("oracle", {
    Address: priceOracle.address,
    price: answer,
    updated: new Date(Number(updatedAt) * 1000).toISOString(),
  });

  await logPrompt("Review the configuration above. Proceed with deployment?");

  console.log();

  // Deploy HashPowerPerpsDEX implementation
  logInfo("Deploy HashPowerPerpsDEX implementation", {
    contract: "HashPowerPerpsDEX",
    args: `minimumPriceIncrement=${env.MINIMUM_PRICE_INCREMENT}`,
  });
  await logPrompt("Proceed?");
  console.log("Deploying HashPowerPerpsDEX implementation...");
  const args = [BigInt(env.MINIMUM_PRICE_INCREMENT)] as const;
  const perpsImpl = await viem.deployContract(
    "contracts/HashPowerPerpsDEX.sol:HashPowerPerpsDEX",
    args,
  );
  logStep("Deployed", addrUrl(pc, perpsImpl.address));

  console.log("Verifying HashPowerPerpsDEX implementation...");
  await verifyContract(perpsImpl.address, args);
  logStep("Verified", addrUrl(pc, perpsImpl.address));

  // Deploy HashPowerPerpsDEX proxy
  logInfo("Deploy HashPowerPerpsDEX proxy", {
    implementation: perpsImpl.address,
    collateralToken: env.COLLATERAL_TOKEN_ADDRESS,
    priceOracle: env.PRICE_ORACLE_ADDRESS,
    marginPercent: `${env.MARGIN_PERCENT}%`,
    maintenanceMarginPercent: `${env.MAINTENANCE_MARGIN_PERCENT}%`,
  });
  await logPrompt("Proceed?");
  console.log("Deploying HashPowerPerpsDEX proxy...");
  const encodedInitFn = encodeFunctionData({
    abi: perpsImpl.abi,
    functionName: "initialize",
    args: [
      env.COLLATERAL_TOKEN_ADDRESS as `0x${string}`,
      env.PRICE_ORACLE_ADDRESS as `0x${string}`,
      Number(env.MARGIN_PERCENT),
      Number(env.MAINTENANCE_MARGIN_PERCENT),
    ],
  });

  const perpsProxy = await viem.deployContract("ERC1967Proxy", [
    perpsImpl.address as `0x${string}`,
    encodedInitFn,
  ]);
  logStep("Deployed", addrUrl(pc, perpsProxy.address));

  const perps = await viem.getContractAt("HashPowerPerpsDEX", perpsProxy.address);

  // Set fees
  logInfo("Set fees", {
    takerFeeBps: env.TAKER_FEE_BPS,
    makerFeeBps: env.MAKER_FEE_BPS,
  });
  await logPrompt("Proceed?");
  console.log("Setting fee bps...");
  const feeRes = await perps.simulate.setMatchFee([
    Number(env.TAKER_FEE_BPS),
    Number(env.MAKER_FEE_BPS),
  ]);
  const feeReceipt = await writeAndWait(deployer, feeRes);
  logStep("Done", txUrl(pc, feeReceipt.transactionHash));

  // Set liquidation fee
  logInfo("Set liquidation fee", { liquidationFee: env.LIQUIDATION_FEE });
  await logPrompt("Proceed?");
  console.log("Setting liquidation fee...");
  const liquidationFeeRes = await perps.simulate.setLiquidationFee([BigInt(env.LIQUIDATION_FEE)]);
  const liquidationFeeReceipt = await writeAndWait(deployer, liquidationFeeRes);
  logStep("Done", txUrl(pc, liquidationFeeReceipt.transactionHash));

  // Transfer ownership if SAFE_OWNER_ADDRESS is set
  if (SAFE_OWNER_ADDRESS) {
    logInfo("Transfer ownership", { owner: SAFE_OWNER_ADDRESS });
    await logPrompt("Proceed?");
    console.log("Transferring ownership...");
    const ownerRes = await perps.simulate.transferOwnership([SAFE_OWNER_ADDRESS]);
    const ownerReceipt = await writeAndWait(deployer, ownerRes);
    logStep("Done", txUrl(pc, ownerReceipt.transactionHash));
  }

  console.log();
  logInfo("config", {
    margin: `${env.MARGIN_PERCENT}%`,
    maintenance: `${env.MAINTENANCE_MARGIN_PERCENT}%`,
    liqFee: env.LIQUIDATION_FEE,
    tick: env.MINIMUM_PRICE_INCREMENT,
    takerFeeBps: env.TAKER_FEE_BPS,
    makerFeeBps: env.MAKER_FEE_BPS,
  });

  logSuccess(addrUrl(pc, perpsProxy.address));

  fs.writeFileSync("perps-addr.tmp", perpsProxy.address);
}

main();
