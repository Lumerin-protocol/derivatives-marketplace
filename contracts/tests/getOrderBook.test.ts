import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits } from "viem";
import { deployPerpsWithCollateralFixture, deployPerpsWithOrdersFixture } from "./fixtures.ts";
import { TimeInForce } from "../fixtures/timeInForce.ts";

const { viem, networkHelpers } = await network.connect();

describe("HashPowerPerpsDEX - Order Book View Functions", function () {
  describe("getOrderBookPrices", function () {
    it("should return empty arrays when no orders exist", async function () {
      const { contracts } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;

      const [bids, asks] = await perps.read.getOrderBookPrices([10n]);
      assert.equal(bids.length, 0);
      assert.equal(asks.length, 0);
    });

    it("should return bid prices sorted highest first", async function () {
      const { contracts, config } = await networkHelpers.loadFixture(deployPerpsWithOrdersFixture);
      const { perps } = contracts;
      const { marketPrice } = config;
      const tick = config.minimumPriceIncrement;

      const [bids] = await perps.read.getOrderBookPrices([10n]);

      assert.equal(bids.length, 3);
      assert.equal(bids[0], marketPrice - tick);
      assert.equal(bids[1], marketPrice - 2n * tick);
      assert.equal(bids[2], marketPrice - 3n * tick);
    });

    it("should return ask prices sorted lowest first", async function () {
      const { contracts, config } = await networkHelpers.loadFixture(deployPerpsWithOrdersFixture);
      const { perps } = contracts;
      const { marketPrice } = config;
      const tick = config.minimumPriceIncrement;

      const [, asks] = await perps.read.getOrderBookPrices([10n]);

      assert.equal(asks.length, 3);
      assert.equal(asks[0], marketPrice + tick);
      assert.equal(asks[1], marketPrice + 2n * tick);
      assert.equal(asks[2], marketPrice + 3n * tick);
    });

    it("should respect maxLevels parameter", async function () {
      const { contracts } = await networkHelpers.loadFixture(deployPerpsWithOrdersFixture);
      const { perps } = contracts;

      const [bids, asks] = await perps.read.getOrderBookPrices([2n]);

      assert.equal(bids.length, 2);
      assert.equal(asks.length, 2);
    });

    it("should update after order is closed", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithOrdersFixture);
      const { perps } = contracts;
      const { buyer } = accounts;
      const { marketPrice } = config;
      const tick = config.minimumPriceIncrement;

      const [bidsBefore] = await perps.read.getOrderBookPrices([10n]);
      assert.ok(bidsBefore.includes(marketPrice - tick));

      const orders = await perps.read.getUserOrders([buyer.account.address]);
      for (const orderId of orders) {
        const order = await perps.read.getOrder([orderId]);
        if (order.price === marketPrice - tick) {
          await perps.write.cancelOrder([orderId], { account: buyer.account });
          break;
        }
      }

      const [bidsAfter] = await perps.read.getOrderBookPrices([10n]);
      assert.ok(!bidsAfter.includes(marketPrice - tick));
    });
  });

  describe("getBestBidPrice", function () {
    it("should return 0 when no bids exist", async function () {
      const { contracts } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;

      const bestBid = await perps.read.getBestBidPrice();
      assert.equal(bestBid, 0n);
    });

    it("should return highest bid price", async function () {
      const { contracts, config } = await networkHelpers.loadFixture(deployPerpsWithOrdersFixture);
      const { perps } = contracts;
      const { marketPrice } = config;
      const tick = config.minimumPriceIncrement;

      const bestBid = await perps.read.getBestBidPrice();
      assert.equal(bestBid, marketPrice - tick);
    });
  });

  describe("getBestAskPrice", function () {
    it("should return 0 when no asks exist", async function () {
      const { contracts } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;

      const bestAsk = await perps.read.getBestAskPrice();
      assert.equal(bestAsk, 0n);
    });

    it("should return lowest ask price", async function () {
      const { contracts, config } = await networkHelpers.loadFixture(deployPerpsWithOrdersFixture);
      const { perps } = contracts;
      const { marketPrice } = config;
      const tick = config.minimumPriceIncrement;

      const bestAsk = await perps.read.getBestAskPrice();
      assert.equal(bestAsk, marketPrice + tick);
    });
  });

  describe("getQuantityAtPrice", function () {
    it("should return 0 for price with no orders", async function () {
      const { contracts, config } = await networkHelpers.loadFixture(deployPerpsWithOrdersFixture);
      const { perps } = contracts;
      const { marketPrice } = config;

      const quantity = await perps.read.getQuantityAtPrice([marketPrice, true]);
      assert.equal(quantity, 0n);
    });

    it("should return correct quantity for bid price", async function () {
      const { contracts, config } = await networkHelpers.loadFixture(deployPerpsWithOrdersFixture);
      const { perps } = contracts;
      const { marketPrice, qty } = config;
      const tick = config.minimumPriceIncrement;

      const quantity = await perps.read.getQuantityAtPrice([marketPrice - tick, true]);
      assert.equal(quantity, BigInt(qty));
    });

    it("should return correct quantity for ask price", async function () {
      const { contracts, config } = await networkHelpers.loadFixture(deployPerpsWithOrdersFixture);
      const { perps } = contracts;
      const { marketPrice, qty } = config;
      const tick = config.minimumPriceIncrement;

      const quantity = await perps.read.getQuantityAtPrice([marketPrice + tick, false]);
      assert.equal(quantity, BigInt(qty));
    });

    it("should aggregate multiple orders at same price", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer, buyer2 } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const price = marketPrice - config.minimumPriceIncrement;
      const qty = parseUnits("1", 6);

      await perps.write.createOrder([price, BigInt(qty), TimeInForce.GTC], { account: buyer.account });
      await perps.write.createOrder([price, BigInt(qty), TimeInForce.GTC], { account: buyer2.account });

      const totalQty = await perps.read.getQuantityAtPrice([price, true]);
      assert.equal(totalQty, BigInt(qty) * 2n);
    });
  });
});
