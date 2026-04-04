import { parseUnits, maxUint256, encodeFunctionData } from "viem";
import type { NetworkConnection } from "hardhat/types/network";
import { computeExpectedFunding as _computeExpectedFunding } from "./utils.ts";

type Conn = NetworkConnection;

async function deployVaultAndPME(conn: Conn, usdcAddress: `0x${string}`, perpsAddress: `0x${string}`) {
  const { viem } = conn;

  const vaultImpl = await viem.deployContract("contracts/CollateralVault.sol:CollateralVault", []);
  const vaultProxy = await viem.deployContract("ERC1967Proxy", [
    vaultImpl.address as `0x${string}`,
    encodeFunctionData({ abi: vaultImpl.abi, functionName: "initialize", args: [usdcAddress] }),
  ]);
  const vault = await viem.getContractAt("CollateralVault", vaultProxy.address);

  const optionsMock = await viem.deployContract(
    "contracts/test/OptionsEngineMock.sol:OptionsEngineMock",
    [],
  );

  const pmeImpl = await viem.deployContract(
    "contracts/PortfolioMarginEngine.sol:PortfolioMarginEngine",
    [],
  );
  const pmeProxy = await viem.deployContract("ERC1967Proxy", [
    pmeImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: pmeImpl.abi,
      functionName: "initialize",
      args: [vault.address, perpsAddress, optionsMock.address],
    }),
  ]);
  const pme = await viem.getContractAt("PortfolioMarginEngine", pmeProxy.address);

  await vault.write.setMarginEngine([pme.address]);
  await vault.write.setAuthorizedCaller([perpsAddress, true]);

  return { vault, pme, optionsMock };
}

export async function deployPerpsFixture(conn: Conn) {
  const { viem } = conn;

  const [owner, seller, buyer, buyer2, seller2] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  const tc = await viem.getTestClient();

  const usdcMock = await viem.deployContract("contracts/USDCMock.sol:USDCMock", []);
  const tokenDecimals = await usdcMock.read.decimals();

  const topUpBalanceUSDC = parseUnits("1000", tokenDecimals);

  const oracleDecimals = 6;
  const initialPrice = parseUnits("2.9976357", oracleDecimals);
  const priceOracle = await viem.deployContract("contracts/PriceOracleMock.sol:PriceOracleMock", [
    initialPrice,
    oracleDecimals,
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

  // Deploy vault first (need address for perps initialize)
  const vaultImpl = await viem.deployContract("contracts/CollateralVault.sol:CollateralVault", []);
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
  const perpsImpl = await viem.deployContract("contracts/HashPowerPerpsDEX.sol:HashPowerPerpsDEX", [
    minimumPriceIncrement,
  ]);
  const perpsProxy = await viem.deployContract("ERC1967Proxy", [
    perpsImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: perpsImpl.abi,
      functionName: "initialize",
      args: [
        usdcMock.address,
        priceOracle.address,
        vault.address,
      ],
    }),
  ]);
  const perps = await viem.getContractAt("HashPowerPerpsDEX", perpsProxy.address);
  const quantityDecimals = await perps.read.QUANTITY_DECIMALS();
  const fundingDecimals = await perps.read.FUNDING_DECIMALS();

  // Deploy PME with options mock
  const optionsMock = await viem.deployContract(
    "contracts/test/OptionsEngineMock.sol:OptionsEngineMock",
    [],
  );
  const pmeImpl = await viem.deployContract(
    "contracts/PortfolioMarginEngine.sol:PortfolioMarginEngine",
    [],
  );
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

  await perps.write.depositReservePool([collateralAmount], { account: owner.account });

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
