import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseUnits, maxUint256, encodeFunctionData } from "viem";
import type { NetworkConnection } from "hardhat/types/network";
import {
  defaultSeries,
  HASHRATE_INDEX_PRICE_E8,
  HASHRATE_LOCAL_OPTIONS_STRIKES_E8,
  HASHRATE_USD_PER_100TH_DAY,
  LIQUIDATION_FEE_BPS,
  INSURANCE_DEPOSIT,
  MIN_OBSERVATIONS,
  ORACLE_DECIMALS,
  SETTLEMENT_WINDOW,
} from "./optionsFixtures.ts";
import { computeExpectedFunding as _computeExpectedFunding } from "./utils.ts";

type Conn = NetworkConnection;

const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

function loadMulticall3DeployedBytecode(): `0x${string}` {
  const path = resolve(
    import.meta.dirname,
    "../artifacts/contracts/Multicall3.sol/Multicall3.json",
  );
  const json = JSON.parse(readFileSync(path, "utf-8")) as { deployedBytecode: `0x${string}` };
  return json.deployedBytecode;
}

export async function deployPerpsFixture(conn: Conn) {
  const { viem } = conn;

  const [owner, seller, buyer, buyer2, seller2] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  const tc = await viem.getTestClient();

  const usdcMock = await viem.deployContract("USDCMock", []);
  const tokenDecimals = await usdcMock.read.decimals();

  const topUpBalanceUSDC = parseUnits("1000", tokenDecimals);

  const oracleDecimals = 6;
  const initialPrice = parseUnits(HASHRATE_USD_PER_100TH_DAY, oracleDecimals);
  const priceOracle = await viem.deployContract("PriceOracleMock", [initialPrice, oracleDecimals]);

  await usdcMock.write.transfer([buyer.account.address, topUpBalanceUSDC]);
  await usdcMock.write.transfer([buyer2.account.address, topUpBalanceUSDC]);
  await usdcMock.write.transfer([seller.account.address, topUpBalanceUSDC]);
  await usdcMock.write.transfer([seller2.account.address, topUpBalanceUSDC]);

  const marginPercent = 10;
  const maintenanceMarginPercent = 5;
  const liquidationFee = parseUnits("1", tokenDecimals);
  const minimumPriceIncrement = parseUnits("0.01", tokenDecimals);
  const takerFeeBps = 5n;
  const makerFeeBps = 0n;
  const collateralAmount = parseUnits("100000", tokenDecimals);

  // Deploy vault first (need address for perps initialize)
  const vaultImpl = await viem.deployContract("CollateralVault", []);
  const vaultProxy = await viem.deployContract("ERC1967Proxy", [
    vaultImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: vaultImpl.abi,
      functionName: "initialize",
      args: [usdcMock.address],
    }),
  ]);
  const vault = await viem.getContractAt("CollateralVault", vaultProxy.address);

  // Deploy perps with vault
  const perpsImpl = await viem.deployContract("HashPowerPerpsDEX", [minimumPriceIncrement]);
  const perpsProxy = await viem.deployContract("ERC1967Proxy", [
    perpsImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: perpsImpl.abi,
      functionName: "initialize",
      args: [usdcMock.address, priceOracle.address, vault.address],
    }),
  ]);
  const perps = await viem.getContractAt("HashPowerPerpsDEX", perpsProxy.address);
  const quantityDecimals = await perps.read.QUANTITY_DECIMALS();
  const fundingDecimals = await perps.read.FUNDING_DECIMALS();

  // Deploy PME with options mock
  const optionsMock = await viem.deployContract("OptionsEngineMock", []);
  const pmeImpl = await viem.deployContract("PortfolioMarginEngine", []);
  const pmeProxy = await viem.deployContract("ERC1967Proxy", [
    pmeImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: pmeImpl.abi,
      functionName: "initialize",
      args: [vault.address, perps.address, optionsMock.address],
    }),
  ]);
  const pme = await viem.getContractAt("PortfolioMarginEngine", pmeProxy.address);

  // Wire vault ↔ perps ↔ PME
  await vault.write.setMarginEngine([pme.address]);
  await vault.write.setAuthorizedCaller([perps.address, true]);
  await perps.write.setPortfolioMargin([pme.address], { account: owner.account });

  await perps.write.setMatchFee([Number(takerFeeBps), Number(makerFeeBps)], {
    account: owner.account,
  });
  await perps.write.setLiquidationFee([liquidationFee], { account: owner.account });

  // Users approve the vault (not the perps contract)
  for (const w of [seller, buyer, buyer2, seller2, owner]) {
    await usdcMock.write.approve([vault.address, maxUint256], { account: w.account });
  }

  await vault.write.depositInsuranceFund([owner.account.address, collateralAmount], { account: owner.account });

  return {
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
      fundingDecimals,
      tokenDecimals,
    },
    contracts: { usdcMock, priceOracle, perps, vault, pme, optionsMock },
    accounts: { owner, seller, seller2, buyer, buyer2, pc, tc },
    utils: {
      getMinimumCollateral: (price: bigint, absQuantity: bigint) => {
        const orderValue = (price * absQuantity) / 10n ** BigInt(quantityDecimals);
        const requiredMargin = (orderValue * BigInt(marginPercent)) / 100n;
        const bpsFee = (orderValue * takerFeeBps) / 10000n;
        const fee = bpsFee > liquidationFee ? bpsFee : liquidationFee;
        return requiredMargin + fee;
      },
    },
  };
}

export async function deployPerpsWithCollateralFixture(conn: Conn) {
  const data = await deployPerpsFixture(conn);
  const { contracts, accounts, config } = data;
  const { perps } = contracts;
  const { seller, buyer, buyer2 } = accounts;

  const collateralPerUser = parseUnits("1000", config.tokenDecimals);
  await perps.write.addCollateral([collateralPerUser], { account: seller.account });
  await perps.write.addCollateral([collateralPerUser], { account: buyer.account });
  await perps.write.addCollateral([collateralPerUser], { account: buyer2.account });

  return { ...data, config: { ...config, collateralPerUser } };
}

export async function deployPerpsWithOrdersFixture(conn: Conn) {
  const data = await deployPerpsWithCollateralFixture(conn);
  const { contracts, accounts, config } = data;
  const { perps } = contracts;
  const { seller, buyer } = accounts;

  const marketPrice = await perps.read.getMarketPrice();
  const tick = config.minimumPriceIncrement;
  const qty = parseUnits("1", config.quantityDecimals);

  await perps.write.createOrder([marketPrice + tick, -qty], { account: seller.account });
  await perps.write.createOrder([marketPrice + 2n * tick, -qty], { account: seller.account });
  await perps.write.createOrder([marketPrice + 3n * tick, -qty], { account: seller.account });
  await perps.write.createOrder([marketPrice - tick, qty], { account: buyer.account });
  await perps.write.createOrder([marketPrice - 2n * tick, qty], { account: buyer.account });
  await perps.write.createOrder([marketPrice - 3n * tick, qty], { account: buyer.account });

  return { ...data, config: { ...config, marketPrice, qty } };
}

export async function deployPerpsWithPositionsFixture(conn: Conn) {
  const data = await deployPerpsWithCollateralFixture(conn);
  const { contracts, accounts, config } = data;
  const { perps } = contracts;
  const { seller, buyer } = accounts;

  const marketPrice = await perps.read.getMarketPrice();
  const qty = parseUnits("1", config.quantityDecimals);

  await perps.write.createOrder([marketPrice, -qty], { account: seller.account });
  await perps.write.createOrder([marketPrice, qty], { account: buyer.account });

  return { ...data, config: { ...config, marketPrice, qty } };
}

export async function deployPerpsWithLiquidatablePositionFixture(conn: Conn) {
  const data = await deployPerpsFixture(conn);
  const { contracts, accounts, config, utils } = data;
  const { perps, priceOracle } = contracts;
  const { seller, buyer } = accounts;

  const initialPrice = await perps.read.getMarketPrice();
  const qty = parseUnits("1", config.quantityDecimals);
  const minCollateral = utils.getMinimumCollateral(initialPrice, qty);

  await perps.write.addCollateral([minCollateral], { account: seller.account });
  await perps.write.addCollateral([minCollateral * 2n], { account: buyer.account });
  await perps.write.createOrder([initialPrice, -qty], { account: seller.account });
  await perps.write.createOrder([initialPrice, qty], { account: buyer.account });

  return {
    ...data,
    config: { ...config, initialPrice, qty, minCollateral },
    async makeLiquidatable() {
      const newPrice = initialPrice * 2n;
      await priceOracle.write.setPrice([newPrice, config.oracle.decimals]);
      return newPrice;
    },
  };
}

export async function deployPerpsWithBatchLiquidatableFixture(conn: Conn) {
  const data = await deployPerpsFixture(conn);
  const { contracts, accounts, config, utils } = data;
  const { perps, priceOracle } = contracts;
  const { seller, seller2, buyer } = accounts;

  const initialPrice = await perps.read.getMarketPrice();
  const qty = parseUnits("1", config.quantityDecimals);
  const minCollateral = utils.getMinimumCollateral(initialPrice, qty);

  await perps.write.addCollateral([minCollateral], { account: seller.account });
  await perps.write.addCollateral([minCollateral], { account: seller2.account });
  await perps.write.addCollateral([minCollateral * 3n], { account: buyer.account });

  await perps.write.createOrder([initialPrice, -qty], { account: seller.account });
  await perps.write.createOrder([initialPrice, -qty], { account: seller2.account });
  await perps.write.createOrder([initialPrice, qty * 2n], { account: buyer.account });

  return {
    ...data,
    config: { ...config, initialPrice, qty, minCollateral },
    async makeLiquidatable() {
      const newPrice = initialPrice * 2n;
      await priceOracle.write.setPrice([newPrice, config.oracle.decimals]);
      return newPrice;
    },
  };
}

export async function deployPerpsWithFundingFixture(conn: Conn) {
  const data = await deployPerpsWithCollateralFixture(conn);
  const { contracts, accounts, config } = data;
  const { perps } = contracts;
  const { owner } = accounts;

  const fundingRateMaxBps = 100n;
  const fundingPeriod = 86400n;

  await perps.write.setFundingParameters([fundingRateMaxBps, fundingPeriod], {
    account: owner.account,
  });

  return {
    ...data,
    config: { ...config, fundingRateMaxBps, fundingPeriod },
    utils: {
      ...data.utils,
      computeExpectedFunding: (
        netQuantity: bigint,
        markPrice: bigint,
        indexPrice: bigint,
        timeElapsed: bigint,
        overrideFundingRateMaxBps?: bigint,
      ) =>
        _computeExpectedFunding(
          netQuantity,
          markPrice,
          indexPrice,
          timeElapsed,
          fundingPeriod,
          overrideFundingRateMaxBps ?? fundingRateMaxBps,
          config.fundingDecimals,
          config.quantityDecimals,
        ),
    },
  };
}

export async function deployPerpsWithFundingAndPositionsFixture(conn: Conn) {
  const data = await deployPerpsWithFundingFixture(conn);
  const { contracts, accounts, config } = data;
  const { perps } = contracts;
  const { seller, buyer } = accounts;

  const marketPrice = await perps.read.getMarketPrice();
  const qty = parseUnits("10", config.quantityDecimals);

  await perps.write.createOrder([marketPrice, -qty], { account: seller.account });
  await perps.write.createOrder([marketPrice, qty], { account: buyer.account });

  return { ...data, config: { ...config, marketPrice, qty } };
}

/**
 * Full local stack: HashPowerPerpsDEX + CollateralVault + PortfolioMarginEngine with real
 * OptionMarginEngine, OptionOrderBook, OptionMatchingRouter, and OptionSettlement (same wiring as prod tests).
 * Oracle / index: hashrate USD per 100 TH/s per day (`HASHRATE_INDEX_PRICE_E8`, 8-dec oracle).
 */
export async function deployLocalFullStackFixture(conn: Conn) {
  const { viem, networkHelpers } = conn;
  const [owner, seller, buyer, buyer2, seller2] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  const tc = await viem.getTestClient();

  await tc.setCode({
    address: MULTICALL3_ADDRESS,
    bytecode: loadMulticall3DeployedBytecode(),
  });

  const usdcMock = await viem.deployContract("USDCMock", []);
  console.log("usdcMock address", usdcMock.address);
  const tokenDecimals = await usdcMock.read.decimals();

  // Leave owner ~120k USDC for reserve pool + insurance after 4× trader top-ups (1M mint)
  const topUpBalanceUSDC = parseUnits("220000", tokenDecimals);

  const priceOracle = await viem.deployContract("PriceOracleMock", [
    HASHRATE_INDEX_PRICE_E8,
    ORACLE_DECIMALS,
  ]);

  await usdcMock.write.transfer([buyer.account.address, topUpBalanceUSDC]);
  await usdcMock.write.transfer([buyer2.account.address, topUpBalanceUSDC]);
  await usdcMock.write.transfer([seller.account.address, topUpBalanceUSDC]);
  await usdcMock.write.transfer([seller2.account.address, topUpBalanceUSDC]);

  const marginPercent = 10;
  const maintenanceMarginPercent = 5;
  const liquidationFee = parseUnits("1", tokenDecimals);
  const minimumPriceIncrement = parseUnits("0.01", tokenDecimals);
  const takerFeeBps = 5n;
  const makerFeeBps = 0n;
  const collateralAmount = parseUnits("100000", tokenDecimals);

  const registryImpl = await viem.deployContract("OptionMarketRegistry", []);
  const registryProxy = await viem.deployContract("ERC1967Proxy", [
    registryImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: registryImpl.abi,
      functionName: "initialize",
      args: [],
    }),
  ]);
  const registry = await viem.getContractAt("OptionMarketRegistry", registryProxy.address);

  const vaultImpl = await viem.deployContract("CollateralVault", []);
  const vaultProxy = await viem.deployContract("ERC1967Proxy", [
    vaultImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: vaultImpl.abi,
      functionName: "initialize",
      args: [usdcMock.address],
    }),
  ]);
  const vault = await viem.getContractAt("CollateralVault", vaultProxy.address);

  const perpsImpl = await viem.deployContract("HashPowerPerpsDEX", [minimumPriceIncrement]);
  const perpsProxy = await viem.deployContract("ERC1967Proxy", [
    perpsImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: perpsImpl.abi,
      functionName: "initialize",
      args: [usdcMock.address, priceOracle.address, vault.address],
    }),
  ]);
  const perps = await viem.getContractAt("HashPowerPerpsDEX", perpsProxy.address);
  const quantityDecimals = await perps.read.QUANTITY_DECIMALS();
  const fundingDecimals = await perps.read.FUNDING_DECIMALS();

  const engineImpl = await viem.deployContract("OptionMarginEngine", []);
  const engineProxy = await viem.deployContract("ERC1967Proxy", [
    engineImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: engineImpl.abi,
      functionName: "initialize",
      args: [registry.address, usdcMock.address, priceOracle.address, vault.address],
    }),
  ]);
  const optionMarginEngine = await viem.getContractAt("OptionMarginEngine", engineProxy.address);

  const pmeImpl = await viem.deployContract("PortfolioMarginEngine", []);
  const pmeProxy = await viem.deployContract("ERC1967Proxy", [
    pmeImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: pmeImpl.abi,
      functionName: "initialize",
      args: [vault.address, perps.address, optionMarginEngine.address],
    }),
  ]);
  const pme = await viem.getContractAt("PortfolioMarginEngine", pmeProxy.address);

  await vault.write.setMarginEngine([pme.address]);
  await vault.write.setAuthorizedCaller([perps.address, true]);
  await vault.write.setAuthorizedCaller([optionMarginEngine.address, true]);
  await perps.write.setPortfolioMargin([pme.address], { account: owner.account });
  await optionMarginEngine.write.setPortfolioMargin([pme.address], { account: owner.account });
  await optionMarginEngine.write.setPerpsDex([perps.address], { account: owner.account });

  await perps.write.setMatchFee([Number(takerFeeBps), Number(makerFeeBps)], {
    account: owner.account,
  });
  await perps.write.setLiquidationFee([liquidationFee], { account: owner.account });

  const bookImpl = await viem.deployContract("OptionOrderBook", []);
  const bookProxy = await viem.deployContract("ERC1967Proxy", [
    bookImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: bookImpl.abi,
      functionName: "initialize",
      args: [registry.address],
    }),
  ]);
  const optionOrderBook = await viem.getContractAt("OptionOrderBook", bookProxy.address);

  const routerImpl = await viem.deployContract("OptionMatchingRouter", []);
  const routerProxy = await viem.deployContract("ERC1967Proxy", [
    routerImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: routerImpl.abi,
      functionName: "initialize",
      args: [registry.address, optionOrderBook.address, optionMarginEngine.address],
    }),
  ]);
  const optionMatchingRouter = await viem.getContractAt(
    "OptionMatchingRouter",
    routerProxy.address,
  );

  const settlementImpl = await viem.deployContract("OptionSettlement", []);
  const settlementProxy = await viem.deployContract("ERC1967Proxy", [
    settlementImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: settlementImpl.abi,
      functionName: "initialize",
      args: [
        registry.address,
        optionMarginEngine.address,
        priceOracle.address,
        BigInt(SETTLEMENT_WINDOW),
        MIN_OBSERVATIONS,
      ],
    }),
  ]);
  const optionSettlement = await viem.getContractAt("OptionSettlement", settlementProxy.address);

  await optionOrderBook.write.setRouter([optionMatchingRouter.address], { account: owner.account });
  await optionMarginEngine.write.setRouter([optionMatchingRouter.address], {
    account: owner.account,
  });
  await optionMarginEngine.write.setSettlement([optionSettlement.address], {
    account: owner.account,
  });
  await optionMarginEngine.write.setLiquidationFeeBps([LIQUIDATION_FEE_BPS], {
    account: owner.account,
  });
  await registry.write.setAuthorizedContract([optionSettlement.address, true], {
    account: owner.account,
  });

  const latest = BigInt(await networkHelpers.time.latest());

  /// Unix-second offsets from `latest` for each listed expiry (local dev chain only).
  const LOCAL_OPTIONS_EXPIRY_OFFSETS_SEC = [604800n, 1209600n, 1814400n] as const; // +1w, +2w, +3w

  for (const offset of LOCAL_OPTIONS_EXPIRY_OFFSETS_SEC) {
    const expiryTs = latest + offset;
    for (const strikeE8 of HASHRATE_LOCAL_OPTIONS_STRIKES_E8) {
      await registry.write.createSeries(
        [
          strikeE8,
          expiryTs,
          true,
          Number(defaultSeries.tickSizeE8),
          defaultSeries.lotSize,
          defaultSeries.initialIV,
        ],
        { account: owner.account },
      );
      await registry.write.createSeries(
        [
          strikeE8,
          expiryTs,
          false,
          Number(defaultSeries.tickSizeE8),
          defaultSeries.lotSize,
          defaultSeries.initialIV,
        ],
        { account: owner.account },
      );
    }
  }

  const seriesId = 1n;
  const putSeriesId = 2n;
  const seriesExpiry = latest + LOCAL_OPTIONS_EXPIRY_OFFSETS_SEC[0];
  const optionSeriesCount =
    LOCAL_OPTIONS_EXPIRY_OFFSETS_SEC.length * HASHRATE_LOCAL_OPTIONS_STRIKES_E8.length * 2;

  for (const w of [seller, buyer, buyer2, seller2, owner]) {
    await usdcMock.write.approve([vault.address, maxUint256], { account: w.account });
  }

  await vault.write.depositInsuranceFund([owner.account.address, collateralAmount], { account: owner.account });

  await optionMarginEngine.write.depositToInsuranceFund([INSURANCE_DEPOSIT], {
    account: owner.account,
  });

  return {
    config: {
      oracle: { price: HASHRATE_INDEX_PRICE_E8, decimals: ORACLE_DECIMALS },
      marginPercent,
      maintenanceMarginPercent,
      liquidationFee,
      minimumPriceIncrement,
      takerFeeBps,
      makerFeeBps,
      collateralAmount,
      quantityDecimals,
      fundingDecimals,
      tokenDecimals,
      seriesId,
      putSeriesId,
      seriesExpiry,
      optionSeriesCount,
    },
    contracts: {
      usdcMock,
      priceOracle,
      perps,
      vault,
      pme,
      optionMarginEngine,
      registry,
      optionOrderBook,
      optionMatchingRouter,
      optionSettlement,
    },
    accounts: { owner, seller, seller2, buyer, buyer2, pc, tc },
    utils: {
      getMinimumCollateral: (price: bigint, absQuantity: bigint) => {
        const orderValue = (price * absQuantity) / 10n ** BigInt(quantityDecimals);
        const requiredMargin = (orderValue * BigInt(marginPercent)) / 100n;
        const bpsFee = (orderValue * takerFeeBps) / 10000n;
        const fee = bpsFee > liquidationFee ? bpsFee : liquidationFee;
        return requiredMargin + fee;
      },
    },
  };
}
