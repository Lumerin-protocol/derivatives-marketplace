import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type Abi,
  type Address,
  encodeFunctionData,
  getContract,
  maxUint256,
  parseUnits,
} from "viem";
import { HashPowerPerpsDEXAbi as hashPowerPerpsDexAbi } from "../abi/HashPowerPerpsDEX.ts";
import { USDCMockAbi as usdcMockAbi } from "../abi/USDCMock.ts";
import { PriceOracleMockAbi as priceOracleMockAbi } from "../abi/PriceOracleMock.ts";
import { CollateralVaultAbi as collateralVaultAbi } from "../abi/CollateralVault.ts";
import {
  HARDHAT_ACCOUNTS,
  createTestPublicClient,
  createTestWalletClient,
  createTestClientInstance,
  hardhat,
} from "./helpers.ts";

const ARTIFACTS_DIR = resolve(import.meta.dirname, "../artifacts");

function loadArtifact(contractPath: string) {
  const raw = readFileSync(resolve(ARTIFACTS_DIR, contractPath), "utf-8");
  const json = JSON.parse(raw);
  return {
    abi: json.abi as Abi,
    bytecode: json.bytecode as `0x${string}`,
    deployedBytecode: json.deployedBytecode as `0x${string}`,
  };
}

// ── Contract deployment helper ───────────────────────────────────────────────

async function deploy(
  walletClient: Awaited<ReturnType<typeof createTestWalletClient>>,
  publicClient: Awaited<ReturnType<typeof createTestPublicClient>>,
  artifact: ReturnType<typeof loadArtifact>,
  args: unknown[] = [],
): Promise<Address> {
  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress)
    throw new Error("Deployment failed — no contract address");
  return receipt.contractAddress;
}

// ── Base deployment fixture ──────────────────────────────────────────────────
//
// Mirrors `contracts/tests/fixtures.ts::deployPerpsFixture` but operates over a
// real JSON-RPC node via raw viem clients (used by keeper / market-maker / e2e
// suites which run as standalone `node --test` processes).
//
// Architecture (post collateral-vault refactor):
//   USDC ─┐
//         ├─► CollateralVault ◄── PortfolioMarginEngine ──► OptionsEngineMock
//         │                                  ▲
//         │                                  │
//         └────► HashPowerPerpsDEX ──────────┘ (setPortfolioMargin)

export async function deployPerpsFixture() {
  const publicClient = createTestPublicClient();
  const testClient = createTestClientInstance();
  const ownerWallet = createTestWalletClient(HARDHAT_ACCOUNTS[0].privateKey);
  const sellerWallet = createTestWalletClient(HARDHAT_ACCOUNTS[1].privateKey);
  const buyerWallet = createTestWalletClient(HARDHAT_ACCOUNTS[2].privateKey);
  const buyer2Wallet = createTestWalletClient(HARDHAT_ACCOUNTS[3].privateKey);
  const keeperWallet = createTestWalletClient(HARDHAT_ACCOUNTS[3].privateKey);
  const seller2Wallet = createTestWalletClient(HARDHAT_ACCOUNTS[4].privateKey);

  // Multicall3 at the well-known address so viem's multicall works
  const multicall3Artifact = loadArtifact(
    "contracts/Multicall3.sol/Multicall3.json",
  );
  await testClient.setCode({
    address: hardhat.contracts.multicall3.address,
    bytecode: multicall3Artifact.deployedBytecode,
  });

  const usdcArtifact = loadArtifact(
    "contracts/mocks/USDCMock.sol/USDCMock.json",
  );
  const oracleArtifact = loadArtifact(
    "contracts/mocks/PriceOracleMock.sol/PriceOracleMock.json",
  );
  const perpsArtifact = loadArtifact(
    "contracts/HashPowerPerpsDEX.sol/HashPowerPerpsDEX.json",
  );
  const proxyArtifact = loadArtifact(
    "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol/ERC1967Proxy.json",
  );
  const vaultArtifact = loadArtifact(
    "collateral-margin/contracts/contracts/CollateralVault.sol/CollateralVault.json",
  );
  const pmeArtifact = loadArtifact(
    "collateral-margin/contracts/contracts/PortfolioMarginEngine.sol/PortfolioMarginEngine.json",
  );
  const optionsMockArtifact = loadArtifact(
    "collateral-margin/contracts/contracts/mocks/OptionsEngineMock.sol/OptionsEngineMock.json",
  );

  const usdcAddress = await deploy(ownerWallet, publicClient, usdcArtifact);
  const usdc = getContract({
    address: usdcAddress,
    abi: usdcMockAbi,
    client: { public: publicClient, wallet: ownerWallet },
  });

  const tokenDecimals = await usdc.read.decimals();
  const topUpBalanceUSDC = parseUnits("1000", tokenDecimals);

  const oracleDecimals = 6;
  const initialPrice = parseUnits("2.9976357", oracleDecimals);
  const oracleAddress = await deploy(
    ownerWallet,
    publicClient,
    oracleArtifact,
    [initialPrice, oracleDecimals],
  );

  await usdc.write.transfer([HARDHAT_ACCOUNTS[1].address, topUpBalanceUSDC]);
  await usdc.write.transfer([HARDHAT_ACCOUNTS[2].address, topUpBalanceUSDC]);
  await usdc.write.transfer([HARDHAT_ACCOUNTS[3].address, topUpBalanceUSDC]);
  await usdc.write.transfer([HARDHAT_ACCOUNTS[4].address, topUpBalanceUSDC]);

  const marginPercent = 10;
  const maintenanceMarginPercent = 5;
  const liquidationFee = parseUnits("1", tokenDecimals);
  const minimumPriceIncrement = parseUnits("0.01", tokenDecimals);
  const takerFeeBps = 5;
  const makerFeeBps = 0;
  const collateralAmount = parseUnits("100000", tokenDecimals);

  // CollateralVault behind a UUPS proxy
  const vaultImplAddress = await deploy(
    ownerWallet,
    publicClient,
    vaultArtifact,
  );
  const vaultInitData = encodeFunctionData({
    abi: vaultArtifact.abi,
    functionName: "initialize",
    args: [usdcAddress],
  });
  const vaultAddress = await deploy(
    ownerWallet,
    publicClient,
    proxyArtifact,
    [vaultImplAddress, vaultInitData],
  );
  const vault = getContract({
    address: vaultAddress,
    abi: collateralVaultAbi,
    client: { public: publicClient, wallet: ownerWallet },
  });

  // HashPowerPerpsDEX behind a UUPS proxy — initialise with (oracle, vault)
  const perpsImplAddress = await deploy(
    ownerWallet,
    publicClient,
    perpsArtifact,
    [minimumPriceIncrement],
  );
  const perpsInitData = encodeFunctionData({
    abi: hashPowerPerpsDexAbi,
    functionName: "initialize",
    args: [oracleAddress, vaultAddress],
  });
  const perpsProxyAddress = await deploy(
    ownerWallet,
    publicClient,
    proxyArtifact,
    [perpsImplAddress, perpsInitData],
  );
  const perps = getContract({
    address: perpsProxyAddress,
    abi: hashPowerPerpsDexAbi,
    client: { public: publicClient, wallet: ownerWallet },
  });
  const quantityDecimals = await perps.read.QUANTITY_DECIMALS();

  // PME (with options-engine mock) behind a UUPS proxy
  const optionsMockAddress = await deploy(
    ownerWallet,
    publicClient,
    optionsMockArtifact,
  );
  const pmeImplAddress = await deploy(ownerWallet, publicClient, pmeArtifact);
  const pmeInitData = encodeFunctionData({
    abi: pmeArtifact.abi,
    functionName: "initialize",
    args: [vaultAddress],
  });
  const pmeAddress = await deploy(ownerWallet, publicClient, proxyArtifact, [
    pmeImplAddress,
    pmeInitData,
  ]);
  const pme = getContract({
    address: pmeAddress,
    abi: pmeArtifact.abi,
    client: { public: publicClient, wallet: ownerWallet },
  });
  await pme.write.setPerps([perpsProxyAddress]);
  await pme.write.setOptions([optionsMockAddress]);

  // Wire vault ↔ perps ↔ PME
  await vault.write.setMarginEngine([pmeAddress]);
  await vault.write.setAuthorizedCaller([perpsProxyAddress, true]);
  await perps.write.setPortfolioMargin([pmeAddress]);

  await perps.write.setMatchFee([takerFeeBps, makerFeeBps]);
  await perps.write.setLiquidationFee([liquidationFee]);

  // Users approve the VAULT (not the perps DEX) — collateral lives in the vault.
  for (const wallet of [
    sellerWallet,
    buyerWallet,
    buyer2Wallet,
    ownerWallet,
    seller2Wallet,
  ]) {
    const usdcForWallet = getContract({
      address: usdcAddress,
      abi: usdcMockAbi,
      client: { wallet },
    });
    await usdcForWallet.write.approve([vaultAddress, maxUint256]);
  }

  await vault.write.depositInsuranceFund([collateralAmount]);
  const startBlock = await publicClient.getBlockNumber();

  const getMinimumCollateral = (price: bigint, absQuantity: bigint) => {
    const orderValue = (price * absQuantity) / 10n ** BigInt(quantityDecimals);
    const requiredMargin = (orderValue * BigInt(marginPercent)) / 100n;
    const bpsFee = (orderValue * BigInt(takerFeeBps)) / 10000n;
    const fee = bpsFee > liquidationFee ? bpsFee : liquidationFee;
    return requiredMargin + fee;
  };

  return {
    clients: {
      publicClient,
      testClient,
      ownerWallet,
      sellerWallet,
      buyerWallet,
      buyer2Wallet,
      keeperWallet,
      seller2Wallet,
    },
    contracts: {
      perpsAddress: perpsProxyAddress,
      usdcAddress,
      oracleAddress,
      vaultAddress,
      pmeAddress,
      optionsMockAddress,
      perps,
      vault,
    },
    config: {
      oracle: { price: initialPrice, decimals: oracleDecimals },
      marginPercent,
      maintenanceMarginPercent,
      liquidationFee,
      minimumPriceIncrement,
      takerFeeBps,
      makerFeeBps,
      collateralAmount,
      quantityDecimals,
      tokenDecimals,
      startBlock,
    },
    getMinimumCollateral,
  };
}

// ── With collateral ──────────────────────────────────────────────────────────

export async function deployWithCollateralFixture() {
  const data = await deployPerpsFixture();
  const { clients, contracts, config } = data;

  const collateralPerUser = parseUnits("1000", config.tokenDecimals);

  for (const wallet of [
    clients.sellerWallet,
    clients.buyerWallet,
    clients.buyer2Wallet,
    clients.seller2Wallet,
  ]) {
    const vault = getContract({
      address: contracts.vaultAddress,
      abi: collateralVaultAbi,
      client: { public: clients.publicClient, wallet },
    });
    await vault.write.deposit([collateralPerUser]);
  }

  return {
    ...data,
    config: { ...config, collateralPerUser },
  };
}

// ── With liquidatable position ────────────────────────────────────────────────

export async function deployWithLiquidatablePositionFixture() {
  const data = await deployPerpsFixture();
  const { clients, contracts, config, getMinimumCollateral } = data;

  const makePerps = (wallet: typeof clients.ownerWallet) =>
    getContract({
      address: contracts.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      client: { public: clients.publicClient, wallet },
    });
  const makeVault = (wallet: typeof clients.ownerWallet) =>
    getContract({
      address: contracts.vaultAddress,
      abi: collateralVaultAbi,
      client: { public: clients.publicClient, wallet },
    });

  const perpsOwner = makePerps(clients.ownerWallet);
  const perpsSeller = makePerps(clients.sellerWallet);
  const perpsSeller2 = makePerps(clients.seller2Wallet);
  const perpsBuyer = makePerps(clients.buyerWallet);

  const initialPrice = (await perpsOwner.read.getMarketPrice()) as bigint;
  const qty = parseUnits("1", config.quantityDecimals);

  const minCollateral = getMinimumCollateral(initialPrice, qty);
  await makeVault(clients.sellerWallet).write.deposit([minCollateral]);
  await makeVault(clients.seller2Wallet).write.deposit([minCollateral]);
  await makeVault(clients.buyerWallet).write.deposit([minCollateral * 3n]);

  await perpsSeller.write.createOrder([initialPrice, -qty]);
  await perpsSeller2.write.createOrder([initialPrice, -qty]);
  await perpsBuyer.write.createOrder([initialPrice, qty * 2n]);

  const makeLiquidatable = async (): Promise<bigint> => {
    const newPrice = initialPrice * 2n;
    const oracle = getContract({
      address: contracts.oracleAddress,
      abi: priceOracleMockAbi,
      client: { wallet: clients.ownerWallet },
    });
    await oracle.write.setPrice([newPrice, config.oracle.decimals]);
    return newPrice;
  };

  return {
    ...data,
    config: { ...config, initialPrice, qty, minCollateral },
    makeLiquidatable,
  };
}
