import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { parseUnits } from "viem";
import { deployPerpsWithCollateralFixture, deployPerpsWithOrdersFixture } from "./fixtures";

describe("PerpsSimple - Order Book View Functions", function () {
  describe("getOrderBookPrices", function () {
    it("should return empty arrays when no orders exist", async function () {
      const { contracts } = await loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;

      const [bids, asks] = await perps.read.getOrderBookPrices([10n]);
      expect(bids.length).to.equal(0);
      expect(asks.length).to.equal(0);
    });

    it("should return bid prices sorted highest first", async function () {
      const { contracts, config } = await loadFixture(deployPerpsWithOrdersFixture);
      const { perps } = contracts;
      const { marketPrice } = config;
      const tick = config.minimumPriceIncrement;

      const [bids] = await perps.read.getOrderBookPrices([10n]);

      expect(bids.length).to.equal(3);
      // Bids should be sorted highest first
      expect(bids[0]).to.equal(marketPrice - tick);
      expect(bids[1]).to.equal(marketPrice - 2n * tick);
      expect(bids[2]).to.equal(marketPrice - 3n * tick);
    });

    it("should return ask prices sorted lowest first", async function () {
      const { contracts, config } = await loadFixture(deployPerpsWithOrdersFixture);
      const { perps } = contracts;
      const { marketPrice } = config;
      const tick = config.minimumPriceIncrement;

      const [, asks] = await perps.read.getOrderBookPrices([10n]);

      expect(asks.length).to.equal(3);
      // Asks should be sorted lowest first
      expect(asks[0]).to.equal(marketPrice + tick);
      expect(asks[1]).to.equal(marketPrice + 2n * tick);
      expect(asks[2]).to.equal(marketPrice + 3n * tick);
    });

    it("should respect maxLevels parameter", async function () {
      const { contracts } = await loadFixture(deployPerpsWithOrdersFixture);
      const { perps } = contracts;

      const [bids, asks] = await perps.read.getOrderBookPrices([2n]);

      expect(bids.length).to.equal(2);
      expect(asks.length).to.equal(2);
    });

    it("should update after order is closed", async function () {
      const { contracts, accounts, config } = await loadFixture(deployPerpsWithOrdersFixture);
      const { perps } = contracts;
      const { buyer } = accounts;
      const { marketPrice } = config;
      const tick = config.minimumPriceIncrement;

      const [bidsBefore] = await perps.read.getOrderBookPrices([10n]);
      expect(bidsBefore).to.include(marketPrice - tick);

      // Find and close the order at best bid
      const orders = await perps.read.getUserOrders([buyer.account.address]);
      for (const orderId of orders) {
        const order = await perps.read.getOrder([orderId]);
        if (order.price === marketPrice - tick) {
          await perps.write.closeOrder([orderId], { account: buyer.account });
          break;
        }
      }

      const [bidsAfter] = await perps.read.getOrderBookPrices([10n]);
      expect(bidsAfter).to.not.include(marketPrice - tick);
    });
  });

  describe("getBestBidPrice", function () {
    it("should return 0 when no bids exist", async function () {
      const { contracts } = await loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;

      const bestBid = await perps.read.getBestBidPrice();
      expect(bestBid).to.equal(0n);
    });

    it("should return highest bid price", async function () {
      const { contracts, config } = await loadFixture(deployPerpsWithOrdersFixture);
      const { perps } = contracts;
      const { marketPrice } = config;
      const tick = config.minimumPriceIncrement;

      const bestBid = await perps.read.getBestBidPrice();
      expect(bestBid).to.equal(marketPrice - tick);
    });
  });

  describe("getBestAskPrice", function () {
    it("should return 0 when no asks exist", async function () {
      const { contracts } = await loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;

      const bestAsk = await perps.read.getBestAskPrice();
      expect(bestAsk).to.equal(0n);
    });

    it("should return lowest ask price", async function () {
      const { contracts, config } = await loadFixture(deployPerpsWithOrdersFixture);
      const { perps } = contracts;
      const { marketPrice } = config;
      const tick = config.minimumPriceIncrement;

      const bestAsk = await perps.read.getBestAskPrice();
      expect(bestAsk).to.equal(marketPrice + tick);
    });
  });

  describe("getQuantityAtPrice", function () {
    it("should return 0 for price with no orders", async function () {
      const { contracts, config } = await loadFixture(deployPerpsWithOrdersFixture);
      const { perps } = contracts;
      const { marketPrice } = config;

      const quantity = await perps.read.getQuantityAtPrice([marketPrice, true]);
      expect(quantity).to.equal(0n);
    });

    it("should return correct quantity for bid price", async function () {
      const { contracts, config } = await loadFixture(deployPerpsWithOrdersFixture);
      const { perps } = contracts;
      const { marketPrice, qty } = config;
      const tick = config.minimumPriceIncrement;

      const quantity = await perps.read.getQuantityAtPrice([marketPrice - tick, true]);
      expect(quantity).to.equal(BigInt(qty));
    });

    it("should return correct quantity for ask price", async function () {
      const { contracts, config } = await loadFixture(deployPerpsWithOrdersFixture);
      const { perps } = contracts;
      const { marketPrice, qty } = config;
      const tick = config.minimumPriceIncrement;

      const quantity = await perps.read.getQuantityAtPrice([marketPrice + tick, false]);
      expect(quantity).to.equal(BigInt(qty));
    });

    it("should aggregate multiple orders at same price", async function () {
      const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer, buyer2 } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const price = marketPrice - config.minimumPriceIncrement;
      const qty = parseUnits("1", 6);

      // Two users place orders at same price
      await perps.write.createOrder([price, BigInt(qty)], { account: buyer.account });
      await perps.write.createOrder([price, BigInt(qty)], { account: buyer2.account });

      const totalQty = await perps.read.getQuantityAtPrice([price, true]);
      expect(totalQty).to.equal(BigInt(qty) * 2n);
    });
  });
});
