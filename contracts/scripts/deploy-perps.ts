import fs from "node:fs";
import { requireEnvsSet } from "../lib/env.ts";
import hre from "hardhat";
import { type Address, encodeFunctionData, getAddress, isAddress, zeroAddress } from "viem";
import { writeAndWait } from "../lib/writeContract.ts";
import { verifyContract } from "../lib/verify.ts";
import { txUrl, addrUrl } from "../lib/explorer.ts";
import { logTitle, logInfo, logStep, logSuccess, logPrompt } from "../lib/log.ts";

function readOptionalAddress(name: string): Address | undefined {
  const raw = process.env[name];
  if (!raw || raw === zeroAddress) return undefined;
  if (!isAddress(raw)) throw new Error(`${name} is not a valid address: ${raw}`);
  return raw;
}

async function main() {
  logTitle("HashPowerPerpsDEX Deployment");
  const { viem } = await hre.network.connect();

  // `marginPercent` / `maintenanceMarginPercent` are no longer set at
  // initialize time — the cross-product PortfolioMarginEngine drives margin via
  // its `imSpotShock` / `mmSpotShock` parameters. The perps contract now reads
  // its underlying ERC20 (and decimals) from the vault.
  const env = requireEnvsSet(
    "VAULT_ADDRESS",
    "PRICE_ORACLE_ADDRESS",
    "TAKER_FEE_BPS",
    "MAKER_FEE_BPS",
    "LIQUIDATION_FEE",
    "MINIMUM_PRICE_INCREMENT",
  );
  const SAFE_OWNER_ADDRESS = readOptionalAddress("SAFE_OWNER_ADDRESS");
  // Contract size is a compile-time constant (CONTRACT_SIZE_HPS_DAY = 1e15 = 1 PH/s over a day → one
  // contract = 1 PH/s/day); it is not deploy-configurable.
  // Optional: wire the perps DEX into the cross-product PortfolioMarginEngine
  // (perps.setPortfolioMargin + PME.setPerps + Vault.setAuthorizedCaller). When
  // the deployer doesn't own the PME or the vault the script logs the calldata
  // for the current owner Safe instead of executing the call.
  const MARGIN_ENGINE_ADDRESS = readOptionalAddress("MARGIN_ENGINE_ADDRESS");

  const [deployer] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  logInfo("deployer", { Address: addrUrl(pc, deployer.account.address) });

  // Verify collateral vault & infer collateral token from it
  const vault = await viem.getContractAt("CollateralVault", env.VAULT_ADDRESS as Address);
  const vaultOwner = await vault.read.owner();
  const deployerIsVaultOwner = getAddress(vaultOwner) === getAddress(deployer.account.address);
  const collateralTokenAddress = await vault.read.collateralToken();
  const collateralToken = await viem.getContractAt(
    "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol:IERC20Metadata",
    collateralTokenAddress,
  );
  logInfo("vault", {
    Address: addrUrl(pc, vault.address),
    Owner: vaultOwner,
    "Deployer can wire vault": deployerIsVaultOwner ? "yes" : "no (wire via current owner)",
  });
  logInfo("collateral", {
    Address: collateralToken.address,
    Symbol: await collateralToken.read.symbol(),
    Name: await collateralToken.read.name(),
    Decimals: await collateralToken.read.decimals(),
  });

  // Verify price oracle
  const priceOracle = await viem.getContractAt(
    "AggregatorV3Interface",
    env.PRICE_ORACLE_ADDRESS as Address,
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
  const perpsImpl = await viem.deployContract("HashPowerPerpsDEX", args);
  logStep("Deployed", addrUrl(pc, perpsImpl.address));

  console.log("Verifying HashPowerPerpsDEX implementation...");
  await verifyContract(perpsImpl.address, args);
  logStep("Verified", addrUrl(pc, perpsImpl.address));

  // Deploy HashPowerPerpsDEX proxy
  logInfo("Deploy HashPowerPerpsDEX proxy", {
    implementation: perpsImpl.address,
    vault: vault.address,
    priceOracle: env.PRICE_ORACLE_ADDRESS,
  });
  await logPrompt("Proceed?");
  console.log("Deploying HashPowerPerpsDEX proxy...");
  const encodedInitFn = encodeFunctionData({
    abi: perpsImpl.abi,
    functionName: "initialize",
    args: [env.PRICE_ORACLE_ADDRESS as Address, vault.address],
  });

  const perpsProxy = await viem.deployContract("ERC1967Proxy", [
    perpsImpl.address as Address,
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

  // Wire the PortfolioMarginEngine (optional)
  if (MARGIN_ENGINE_ADDRESS) {
    const pme = await viem.getContractAt("PortfolioMarginEngine", MARGIN_ENGINE_ADDRESS);
    const pmeOwner = await pme.read.owner();
    const deployerIsPmeOwner = getAddress(pmeOwner) === getAddress(deployer.account.address);

    logInfo("HashPowerPerpsDEX.setPortfolioMargin", { marginEngine: MARGIN_ENGINE_ADDRESS });
    await logPrompt("Proceed?");
    {
      const sim = await perps.simulate.setPortfolioMargin([MARGIN_ENGINE_ADDRESS]);
      const receipt = await writeAndWait(deployer, sim);
      logStep("Done", txUrl(pc, receipt.transactionHash));
    }

    if (deployerIsPmeOwner) {
      logInfo("PME.setPerps", { perps: perps.address });
      await logPrompt("Proceed?");
      const sim = await pme.simulate.setPerps([perps.address]);
      const receipt = await writeAndWait(deployer, sim);
      logStep("Done", txUrl(pc, receipt.transactionHash));
    } else {
      const data = encodeFunctionData({
        abi: pme.abi,
        functionName: "setPerps",
        args: [perps.address],
      });
      logInfo("PME wiring (run as PME owner)", { "PME address": pme.address, "PME owner": pmeOwner });
      logStep(`PME.setPerps(${perps.address})`, data);
    }

    if (deployerIsVaultOwner) {
      logInfo("Vault.setAuthorizedCaller(perps)", { caller: perps.address });
      await logPrompt("Proceed?");
      const sim = await vault.simulate.setAuthorizedCaller([perps.address, true]);
      const receipt = await writeAndWait(deployer, sim);
      logStep("Done", txUrl(pc, receipt.transactionHash));
    } else {
      const data = encodeFunctionData({
        abi: vault.abi,
        functionName: "setAuthorizedCaller",
        args: [perps.address, true],
      });
      logInfo("Vault wiring (run as vault owner)", {
        "Vault address": vault.address,
        "Vault owner": vaultOwner,
      });
      logStep(`Vault.setAuthorizedCaller(${perps.address}, true)`, data);
    }
  }

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
    liqFee: env.LIQUIDATION_FEE,
    tick: env.MINIMUM_PRICE_INCREMENT,
    takerFeeBps: env.TAKER_FEE_BPS,
    makerFeeBps: env.MAKER_FEE_BPS,
    contractSizeHpsDay: "1000000000000000",
  });

  logSuccess(addrUrl(pc, perpsProxy.address));

  fs.writeFileSync("perps-addr.tmp", perpsProxy.address);
}

main();
