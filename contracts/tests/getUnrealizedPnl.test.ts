import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { parseUnits } from "viem";
import {
  deployPerpsWithCollateralFixture,
  deployPerpsWithPositionsFixture,
  deployPerpsWithLiquidatablePositionFixture,
} from "./fixtures";

describe("PerpsSimple - getUnrealizedPnl", function () {
  it("should return 0 when user has no position", async function () {
    const { contracts, accounts } = await loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    const pnl = await perps.read.getUnrealizedPnl([buyer.account.address]);
    expect(pnl).to.equal(0n);
  });

  it("should return 0 when price has not moved", async function () {
    const { contracts, accounts, config } = await loadFixture(deployPerpsWithPositionsFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    // Price has not moved since position was opened
    const pnl = await perps.read.getUnrealizedPnl([buyer.account.address]);
    expect(pnl).to.equal(0n);
  });

  it("should return positive PnL for long when price increases", async function () {
    const { contracts, accounts, config } = await loadFixture(deployPerpsWithPositionsFixture);
    const { perps, priceOracle } = contracts;
    const { buyer } = accounts;

    // Buyer has long position at marketPrice
    const currentPrice = await perps.read.getMarketPrice();
    const newPrice = (currentPrice * 110n) / 100n; // 10% increase
    await priceOracle.write.setPrice([newPrice, 6n]);

    const pnl = await perps.read.getUnrealizedPnl([buyer.account.address]);
    expect(pnl > 0n).to.be.true;
  });

  it("should return negative PnL for long when price decreases", async function () {
    const { contracts, accounts } = await loadFixture(deployPerpsWithPositionsFixture);
    const { perps, priceOracle } = contracts;
    const { buyer } = accounts;

    // Buyer has long position at marketPrice
    const currentPrice = await perps.read.getMarketPrice();
    const newPrice = (currentPrice * 90n) / 100n; // 10% decrease
    await priceOracle.write.setPrice([newPrice, 6n]);

    const pnl = await perps.read.getUnrealizedPnl([buyer.account.address]);
    expect(pnl < 0n).to.be.true;
  });

  it("should return positive PnL for short when price decreases", async function () {
    const { contracts, accounts } = await loadFixture(deployPerpsWithPositionsFixture);
    const { perps, priceOracle } = contracts;
    const { seller } = accounts;

    // Seller has short position at marketPrice
    const currentPrice = await perps.read.getMarketPrice();
    const newPrice = (currentPrice * 90n) / 100n; // 10% decrease
    await priceOracle.write.setPrice([newPrice, 6n]);

    const pnl = await perps.read.getUnrealizedPnl([seller.account.address]);
    expect(pnl > 0n).to.be.true;
  });

  it("should return negative PnL for short when price increases", async function () {
    const { contracts, accounts } = await loadFixture(deployPerpsWithPositionsFixture);
    const { perps, priceOracle } = contracts;
    const { seller } = accounts;

    // Seller has short position at marketPrice
    const currentPrice = await perps.read.getMarketPrice();
    const newPrice = (currentPrice * 110n) / 100n; // 10% increase
    await priceOracle.write.setPrice([newPrice, 6n]);

    const pnl = await perps.read.getUnrealizedPnl([seller.account.address]);
    expect(pnl < 0n).to.be.true;
  });

  it("should return opposite PnL for long and short at same price move", async function () {
    const { contracts, accounts } = await loadFixture(deployPerpsWithPositionsFixture);
    const { perps, priceOracle } = contracts;
    const { buyer, seller } = accounts;

    // Move price
    const currentPrice = await perps.read.getMarketPrice();
    const newPrice = (currentPrice * 105n) / 100n;
    await priceOracle.write.setPrice([newPrice, 6n]);

    const buyerPnl = await perps.read.getUnrealizedPnl([buyer.account.address]);
    const sellerPnl = await perps.read.getUnrealizedPnl([seller.account.address]);

    // They should have opposite PnL (one gains, other loses)
    expect(buyerPnl > 0n).to.be.true;
    expect(sellerPnl < 0n).to.be.true;

    // Absolute values should be equal (zero-sum)
    expect(buyerPnl).to.equal(-sellerPnl);
  });

  it("should calculate PnL correctly based on position size and price diff", async function () {
    const { contracts, accounts, config } = await loadFixture(deployPerpsWithPositionsFixture);
    const { perps, priceOracle } = contracts;
    const { buyer } = accounts;

    const position = await perps.read.getUserPosition([buyer.account.address]);
    const entryPrice = position.aggregatedEntryPrice;
    const quantity = position.netQuantity;

    // Move price by known amount
    const priceDiff = parseUnits("1000", 6); // $1000 increase
    const newPrice = entryPrice + priceDiff;
    await priceOracle.write.setPrice([newPrice, 6n]);

    const pnl = await perps.read.getUnrealizedPnl([buyer.account.address]);

    // Expected PnL = priceDiff * quantity / 10^QUANTITY_DECIMALS
    const expectedPnl = (priceDiff * quantity) / BigInt(10 ** 6);
    expect(pnl).to.equal(expectedPnl);
  });
});
