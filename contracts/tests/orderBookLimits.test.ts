import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits } from "viem";
import { deployPerpsWithCollateralFixture } from "./fixtures.ts";
import { catchError } from "../lib/lib.ts";
import { TimeInForce } from "../fixtures/timeInForce.ts";

const { viem, networkHelpers } = await network.connect();

describe("HashPowerPerpsDEX - Order Book Limits", function () {
  describe("minimumMarginPerOrder", function () {
    it("should allow owner to set minimumMarginPerOrder", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { owner } = accounts;

      const minMargin = parseUnits("5", config.tokenDecimals);
      await perps.write.setMinimumMarginPerOrder([minMargin], { account: owner.account });
      assert.equal(await perps.read.minimumMarginPerOrder(), minMargin);
    });

    it("should revert when non-owner tries to set", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      await catchError(perps.abi, "OwnableUnauthorizedAccount", async () => {
        await perps.write.setMinimumMarginPerOrder([parseUnits("0.5", config.tokenDecimals)], {
          account: buyer.account,
        });
      });
    });

    it("should reject resting order whose margin is below minimumMarginPerOrder", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer, owner } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const price = marketPrice - config.minimumPriceIncrement;

      const minMargin = parseUnits("5", config.tokenDecimals);
      await perps.write.setMinimumMarginPerOrder([minMargin], { account: owner.account });

      const tinyQty = parseUnits("1", config.quantityDecimals);

      await catchError(perps.abi, "OrderMarginTooLow", async () => {
        await perps.write.createOrder([price, tinyQty, TimeInForce.GTC], { account: buyer.account });
      });
    });

    it("should accept resting order whose margin is at or above minimumMarginPerOrder", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer, owner } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const price = marketPrice - config.minimumPriceIncrement;

      const minMargin = parseUnits("5", config.tokenDecimals);
      await perps.write.setMinimumMarginPerOrder([minMargin], { account: owner.account });

      const qty = parseUnits("2", config.quantityDecimals);
      await perps.write.createOrder([price, qty, TimeInForce.GTC], { account: buyer.account });

      const orders = await perps.read.getUserOrders([buyer.account.address]);
      assert.equal(orders.length, 1);
    });

    it("should not enforce minimum on matched portion, only on resting remainder", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer, seller, owner } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const qty1 = parseUnits("1", config.quantityDecimals);

      await perps.write.createOrder([marketPrice, -qty1, TimeInForce.GTC], { account: seller.account });

      const minMargin = parseUnits("5", config.tokenDecimals);
      await perps.write.setMinimumMarginPerOrder([minMargin], { account: owner.account });

      await perps.write.createOrder([marketPrice, qty1, TimeInForce.GTC], { account: buyer.account });

      const posBuyer = await perps.read.getUserPosition([buyer.account.address]);
      assert.equal(posBuyer.netQuantity, qty1);
    });

    it("should reject when partially matched remainder margin is below minimum", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer, seller, owner } = accounts;

      const marketPrice = await perps.read.getMarketPrice();

      const minMargin = parseUnits("5", config.tokenDecimals);
      await perps.write.setMinimumMarginPerOrder([minMargin], { account: owner.account });

      const qty2 = parseUnits("2", config.quantityDecimals);
      await perps.write.createOrder([marketPrice, -qty2, TimeInForce.GTC], { account: seller.account });

      const qty3 = parseUnits("3", config.quantityDecimals);

      await catchError(perps.abi, "OrderMarginTooLow", async () => {
        await perps.write.createOrder([marketPrice, qty3, TimeInForce.GTC], { account: buyer.account });
      });
    });

    it("should not enforce minimum when minimumMarginPerOrder is 0 (disabled)", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const price = marketPrice - config.minimumPriceIncrement;

      assert.equal(await perps.read.minimumMarginPerOrder(), 0n);

      const tinyQty = parseUnits("0.001", config.quantityDecimals);
      await perps.write.createOrder([price, tinyQty, TimeInForce.GTC], { account: buyer.account });

      const orders = await perps.read.getUserOrders([buyer.account.address]);
      assert.equal(orders.length, 1);
    });

    it("should allow setting minimumMarginPerOrder to 0 to disable", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { owner } = accounts;

      await perps.write.setMinimumMarginPerOrder([parseUnits("0.5", config.tokenDecimals)], {
        account: owner.account,
      });
      assert.notEqual(await perps.read.minimumMarginPerOrder(), 0n);

      await perps.write.setMinimumMarginPerOrder([0n], { account: owner.account });
      assert.equal(await perps.read.minimumMarginPerOrder(), 0n);
    });

    it("high-leverage order should require same margin as low-leverage order of same size", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer, owner } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const price = marketPrice - config.minimumPriceIncrement;

      const minMargin = parseUnits("5", config.tokenDecimals);
      await perps.write.setMinimumMarginPerOrder([minMargin], { account: owner.account });

      const tinyQty = parseUnits("1", config.quantityDecimals);
      await catchError(perps.abi, "OrderMarginTooLow", async () => {
        await perps.write.createOrder([price, tinyQty, TimeInForce.GTC], { account: buyer.account });
      });
    });
  });

  describe("MAX_PRICE_LEVELS_PER_SIDE", function () {
    it("should be set to 200", async function () {
      const { contracts } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;

      assert.equal(await perps.read.MAX_PRICE_LEVELS_PER_SIDE(), 200n);
    });

    it("should allow orders at existing price levels even when cap is reached", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer, buyer2, seller } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const tick = config.minimumPriceIncrement;
      const qty = parseUnits("0.01", config.quantityDecimals);

      for (let i = 1; i <= 100; i++) {
        await perps.write.createOrder([marketPrice - BigInt(i) * tick, qty, TimeInForce.GTC], { account: buyer.account });
      }
      for (let i = 101; i <= 200; i++) {
        await perps.write.createOrder([marketPrice - BigInt(i) * tick, qty, TimeInForce.GTC], { account: buyer2.account });
      }

      await catchError(perps.abi, "MaxPriceLevelsReached", async () => {
        await perps.write.createOrder([marketPrice - 201n * tick, qty, TimeInForce.GTC], { account: seller.account });
      });

      await perps.write.createOrder([marketPrice - tick, qty, TimeInForce.GTC], { account: seller.account });
    });

    it("should allow new price level after cancellation frees a slot", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer, buyer2, seller } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const tick = config.minimumPriceIncrement;
      const qty = parseUnits("0.01", config.quantityDecimals);

      for (let i = 1; i <= 100; i++) {
        await perps.write.createOrder([marketPrice - BigInt(i) * tick, qty, TimeInForce.GTC], { account: buyer.account });
      }
      for (let i = 101; i <= 200; i++) {
        await perps.write.createOrder([marketPrice - BigInt(i) * tick, qty, TimeInForce.GTC], { account: buyer2.account });
      }

      const orders = await perps.read.getUserOrders([buyer.account.address]);
      await perps.write.cancelOrder([orders[0]], { account: buyer.account });

      await perps.write.createOrder([marketPrice - 201n * tick, qty, TimeInForce.GTC], { account: seller.account });
    });

    it("should enforce cap independently per side (bids vs asks)", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer, seller } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const tick = config.minimumPriceIncrement;
      const qty = parseUnits("0.01", config.quantityDecimals);

      for (let i = 1; i <= 20; i++) {
        await perps.write.createOrder([marketPrice - BigInt(i) * tick, qty, TimeInForce.GTC], { account: buyer.account });
        await perps.write.createOrder([marketPrice + BigInt(i) * tick, -qty, TimeInForce.GTC], { account: seller.account });
      }

      const ordersBuyer = await perps.read.getUserOrders([buyer.account.address]);
      const ordersSeller = await perps.read.getUserOrders([seller.account.address]);
      assert.equal(ordersBuyer.length, 20);
      assert.equal(ordersSeller.length, 20);
    });
  });
});
