import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits } from "viem";
import {
  deployPerpsWithCollateralFixture,
  deployPerpsWithPositionsFixture,
  deployPerpsWithLiquidatablePositionFixture,
} from "./fixtures.ts";

const { viem, networkHelpers } = await network.connect();

describe("HashPowerPerpsDEX - getUnrealizedPnl", function () {
  it("should return 0 when user has no position", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    const pnl = await perps.read.getUnrealizedPnl([buyer.account.address]);
    assert.equal(pnl, 0n);
  });

  it("should return 0 when price has not moved", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithPositionsFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    const pnl = await perps.read.getUnrealizedPnl([buyer.account.address]);
    assert.equal(pnl, 0n);
  });

  it("should return positive PnL for long when price increases", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithPositionsFixture);
    const { perps, priceOracle } = contracts;
    const { buyer } = accounts;

    const currentPrice = await perps.read.getMarketPrice();
    const newPrice = (currentPrice * 110n) / 100n;
    await priceOracle.write.setPrice([newPrice, 6n]);

    const pnl = await perps.read.getUnrealizedPnl([buyer.account.address]);
    assert.ok(pnl > 0n);
  });

  it("should return negative PnL for long when price decreases", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithPositionsFixture);
    const { perps, priceOracle } = contracts;
    const { buyer } = accounts;

    const currentPrice = await perps.read.getMarketPrice();
    const newPrice = (currentPrice * 90n) / 100n;
    await priceOracle.write.setPrice([newPrice, 6n]);

    const pnl = await perps.read.getUnrealizedPnl([buyer.account.address]);
    assert.ok(pnl < 0n);
  });

  it("should return positive PnL for short when price decreases", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithPositionsFixture);
    const { perps, priceOracle } = contracts;
    const { seller } = accounts;

    const currentPrice = await perps.read.getMarketPrice();
    const newPrice = (currentPrice * 90n) / 100n;
    await priceOracle.write.setPrice([newPrice, 6n]);

    const pnl = await perps.read.getUnrealizedPnl([seller.account.address]);
    assert.ok(pnl > 0n);
  });

  it("should return negative PnL for short when price increases", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithPositionsFixture);
    const { perps, priceOracle } = contracts;
    const { seller } = accounts;

    const currentPrice = await perps.read.getMarketPrice();
    const newPrice = (currentPrice * 110n) / 100n;
    await priceOracle.write.setPrice([newPrice, 6n]);

    const pnl = await perps.read.getUnrealizedPnl([seller.account.address]);
    assert.ok(pnl < 0n);
  });

  it("should return opposite PnL for long and short at same price move", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithPositionsFixture);
    const { perps, priceOracle } = contracts;
    const { buyer, seller } = accounts;

    const currentPrice = await perps.read.getMarketPrice();
    const newPrice = (currentPrice * 105n) / 100n;
    await priceOracle.write.setPrice([newPrice, 6n]);

    const buyerPnl = await perps.read.getUnrealizedPnl([buyer.account.address]);
    const sellerPnl = await perps.read.getUnrealizedPnl([seller.account.address]);

    assert.ok(buyerPnl > 0n);
    assert.ok(sellerPnl < 0n);
    assert.equal(buyerPnl, -sellerPnl);
  });

  it("should calculate PnL correctly based on position size and price diff", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithPositionsFixture);
    const { perps, priceOracle } = contracts;
    const { buyer } = accounts;

    const position = await perps.read.getUserPosition([buyer.account.address]);
    const entryPrice = position.aggregatedEntryPrice;
    const quantity = position.netQuantity;

    const priceDiff = parseUnits("1000", 6);
    const newPrice = entryPrice + priceDiff;
    await priceOracle.write.setPrice([newPrice, 6n]);

    const pnl = await perps.read.getUnrealizedPnl([buyer.account.address]);

    const expectedPnl = (priceDiff * quantity) / BigInt(10 ** 6);
    assert.equal(pnl, expectedPnl);
  });
});
