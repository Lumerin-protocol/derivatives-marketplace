import { viem } from "hardhat";
import { parseUnits, maxUint256, encodeFunctionData, formatUnits } from "viem";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

export async function deployPerpsFixture() {
  // Get wallet clients
  const [owner, seller, buyer, buyer2] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  const tc = await viem.getTestClient();
  // Deploy USDC Mock
  const _usdcMock = await viem.deployContract("contracts/USDCMock.sol:USDCMock", []);
  const usdcMock = await viem.getContractAt(
    "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol:IERC20Metadata",
    _usdcMock.address
  );
  const tokenDecimals = await usdcMock.read.decimals();

  const topUpBalanceUSDC = parseUnits("1000", tokenDecimals); // 100,000 USDC for testing

  // Deploy Price Oracle Mock with proper timestamp handling
  const oracleDecimals = 6;
  const initialPrice = parseUnits("2.9976357", oracleDecimals); // current hash price
  const priceOracle = await viem.deployContract("contracts/PriceOracleMock.sol:PriceOracleMock", [
    initialPrice,
    oracleDecimals,
  ]);

  // Top up accounts with USDC
  await usdcMock.write.transfer([buyer.account.address, topUpBalanceUSDC]);
  await usdcMock.write.transfer([buyer2.account.address, topUpBalanceUSDC]);
  await usdcMock.write.transfer([seller.account.address, topUpBalanceUSDC]);

  // Configuration
  const marginPercent = 10n; // 10% initial margin
  const maintenanceMarginPercent = 5n; // 5% maintenance margin
  const liquidationFee = parseUnits("1", tokenDecimals); // 10 USDC liquidation fee
  const minimumPriceIncrement = parseUnits("0.01", tokenDecimals); // 1 USDC price tick
  const orderFee = parseUnits("1", tokenDecimals); // 1 USDC order fee
  const collateralAmount = parseUnits("100000", tokenDecimals); // Reserve pool initial deposit

  // Deploy PerpsSimple contract
  const perpsImpl = await viem.deployContract("contracts/PerpsSimple.sol:PerpsSimple", []);
  const perpsProxy = await viem.deployContract("ERC1967Proxy", [
    perpsImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: perpsImpl.abi,
      functionName: "initialize",
      args: [
        usdcMock.address,
        priceOracle.address,
        marginPercent,
        maintenanceMarginPercent,
        liquidationFee,
        minimumPriceIncrement,
      ],
    }),
  ]);
  const perps = await viem.getContractAt("PerpsSimple", perpsProxy.address);
  const quantityDecimals = await perps.read.QUANTITY_DECIMALS();

  // Set order fee
  await perps.write.setOrderFee([orderFee], { account: owner.account });

  // Approve perps contract to spend USDC for all accounts
  await usdcMock.write.approve([perps.address, maxUint256], { account: seller.account });
  await usdcMock.write.approve([perps.address, maxUint256], { account: buyer.account });
  await usdcMock.write.approve([perps.address, maxUint256], { account: buyer2.account });
  await usdcMock.write.approve([perps.address, maxUint256], { account: owner.account });

  // Deposit to reserve pool
  await perps.write.depositReservePool([collateralAmount], { account: owner.account });

  const oracle = {
    price: initialPrice,
    decimals: oracleDecimals,
  };

  return {
    config: {
      oracle,
      marginPercent,
      maintenanceMarginPercent,
      liquidationFee,
      minimumPriceIncrement,
      orderFee,
      collateralAmount,
      quantityDecimals,
      tokenDecimals,
    },
    contracts: {
      usdcMock,
      priceOracle,
      perps,
    },
    accounts: {
      owner,
      seller,
      buyer,
      buyer2,
      pc,
      tc,
    },
    utils: {
      getMinimumCollateral: (price: bigint, absQuantity: bigint) => {
        const orderValue = (price * absQuantity) / 10n ** BigInt(quantityDecimals);
        const requiredMargin = (orderValue * marginPercent) / 100n;
        return requiredMargin + orderFee;
      },
    },
  };
}

export async function deployPerpsWithCollateralFixture() {
  const data = await loadFixture(deployPerpsFixture);
  const { contracts, accounts, config } = data;
  const { perps } = contracts;
  const { seller, buyer, buyer2 } = accounts;

  // Add collateral for each participant
  const collateralPerUser = parseUnits("1000", config.tokenDecimals);
  await perps.write.addCollateral([collateralPerUser], { account: seller.account });
  await perps.write.addCollateral([collateralPerUser], { account: buyer.account });
  await perps.write.addCollateral([collateralPerUser], { account: buyer2.account });

  return {
    ...data,
    config: {
      ...config,
      collateralPerUser,
    },
  };
}

export async function deployPerpsWithOrdersFixture() {
  const data = await loadFixture(deployPerpsWithCollateralFixture);
  const { contracts, accounts, config } = data;
  const { perps } = contracts;
  const { seller, buyer } = accounts;

  // Get market price from oracle
  const marketPrice = await perps.read.getMarketPrice();
  const tick = config.minimumPriceIncrement;

  // Quantity: 1 unit (with 6 decimals)
  const qty = parseUnits("1", config.quantityDecimals);

  // Create sell orders (asks) - above market price
  await perps.write.createOrder([marketPrice + tick, -qty], { account: seller.account });
  await perps.write.createOrder([marketPrice + 2n * tick, -qty], {
    account: seller.account,
  });
  await perps.write.createOrder([marketPrice + 3n * tick, -qty], {
    account: seller.account,
  });

  // Create buy orders (bids) - below market price
  await perps.write.createOrder([marketPrice - tick, qty], { account: buyer.account });
  await perps.write.createOrder([marketPrice - 2n * tick, qty], { account: buyer.account });
  await perps.write.createOrder([marketPrice - 3n * tick, qty], { account: buyer.account });

  return {
    ...data,
    config: {
      ...config,
      marketPrice,
      qty,
    },
  };
}

export async function deployPerpsWithPositionsFixture() {
  const data = await loadFixture(deployPerpsWithCollateralFixture);
  const { contracts, accounts, config } = data;
  const { perps } = contracts;
  const { seller, buyer } = accounts;

  // Get market price from oracle
  const marketPrice = await perps.read.getMarketPrice();

  // Quantity: 1 unit (with 6 decimals)
  const qty = parseUnits("1", config.quantityDecimals);

  // Create matching orders at market price
  // Seller places a sell order first
  await perps.write.createOrder([marketPrice, -qty], { account: seller.account });

  // Buyer places a buy order that matches
  await perps.write.createOrder([marketPrice, qty], { account: buyer.account });

  return {
    ...data,
    config: {
      ...config,
      marketPrice,
      qty,
    },
  };
}

export async function deployPerpsWithLiquidatablePositionFixture() {
  const data = await loadFixture(deployPerpsFixture);
  const { contracts, accounts, config, utils } = data;
  const { perps, priceOracle } = contracts;
  const { seller, buyer } = accounts;

  // Get initial market price
  const initialPrice = await perps.read.getMarketPrice();
  const qty = parseUnits("0.1", config.quantityDecimals);

  // Add minimal collateral to seller (just enough to create position)
  const minCollateral = utils.getMinimumCollateral(initialPrice, qty);
  await perps.write.addCollateral([minCollateral], { account: seller.account });

  // Add more collateral to buyer
  await perps.write.addCollateral([minCollateral * 2n], {
    account: buyer.account,
  });

  // Quantity: small position

  // Create matching orders at initial price
  await perps.write.createOrder([initialPrice, -qty], { account: seller.account });
  await perps.write.createOrder([initialPrice, qty], { account: buyer.account });

  // Now the seller has a short position
  // If price goes up significantly, seller will be liquidatable

  return {
    ...data,
    config: {
      ...config,
      initialPrice,
      qty,
      minCollateral,
    },
    // Helper function to make seller liquidatable by moving price up
    async makeLiquidatable() {
      // Increase price by 50% to put short position underwater
      const newPrice = (initialPrice * 150n) / 100n;
      await priceOracle.write.setPrice([newPrice, config.oracle.decimals]);
      return newPrice;
    },
  };
}
