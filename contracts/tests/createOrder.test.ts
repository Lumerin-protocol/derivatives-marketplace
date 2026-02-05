import { config, expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { parseUnits, getAddress, parseEventLogs } from "viem";
import { deployPerpsWithCollateralFixture, deployPerpsWithOrdersFixture } from "./fixtures";

describe("PerpsSimple - createOrder", function () {
  describe("Order Creation", function () {
    it("should create a buy order successfully", async function () {
      const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const price = marketPrice - config.minimumPriceIncrement;
      const quantity = parseUnits("1", 6);

      await perps.write.createOrder([price, quantity], {
        account: buyer.account,
      });

      const orders = await perps.read.getUserOrders([buyer.account.address]);
      expect(orders.length).to.equal(1);

      const order = await perps.read.getOrder([orders[0]]);
      expect(order.price).to.equal(price);
      expect(order.quantity).to.equal(quantity);
      expect(getAddress(order.participant)).to.equal(getAddress(buyer.account.address));
    });

    it("should create a sell order successfully", async function () {
      const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { seller } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const price = marketPrice + config.minimumPriceIncrement;
      const quantity = parseUnits("1", config.quantityDecimals);

      await perps.write.createOrder([price, -quantity], {
        account: seller.account,
      });

      const orders = await perps.read.getUserOrders([seller.account.address]);
      expect(orders.length).to.equal(1);

      const order = await perps.read.getOrder([orders[0]]);
      expect(order.price).to.equal(price);
      expect(order.quantity).to.equal(-BigInt(quantity));
    });

    it("should revert on zero quantity", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      const marketPrice = await perps.read.getMarketPrice();

      await expect(
        perps.write.createOrder([marketPrice, 0n], {
          account: buyer.account,
        })
      ).to.be.rejectedWith("InvalidSize");
    });

    it("should revert on zero price", async function () {
      const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      const quantity = parseUnits("1", config.quantityDecimals);

      await expect(
        perps.write.createOrder([0n, quantity], {
          account: buyer.account,
        })
      ).to.be.rejectedWith("InvalidPrice");
    });

    it("should revert when price is not a multiple of minimumPriceIncrement", async function () {
      const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const invalidPrice = marketPrice + config.minimumPriceIncrement / 2n;
      const quantity = parseUnits("1", config.quantityDecimals);

      await expect(
        perps.write.createOrder([invalidPrice, quantity], {
          account: buyer.account,
        })
      ).to.be.rejectedWith("InvalidPrice");
    });
  });

  describe("Limit Price Matching", function () {
    it("should match buy order with lower-priced sell orders", async function () {
      const { contracts, accounts, config } = await loadFixture(deployPerpsWithOrdersFixture);
      const { perps } = contracts;
      const { buyer2, pc } = accounts;
      const { marketPrice, qty } = config;
      const tick = config.minimumPriceIncrement;

      // Best ask is at marketPrice + tick
      // Place a buy order at marketPrice + 2*tick (should match with best ask)
      const buyPrice = marketPrice + 2n * tick;

      const hash = await perps.write.createOrder([buyPrice, qty], {
        account: buyer2.account,
      });

      const receipt = await pc.waitForTransactionReceipt({ hash });

      const [orderMatchedEvent] = parseEventLogs({
        logs: receipt.logs,
        abi: perps.abi,
        eventName: "OrderMatched",
      });

      // Buyer2 should have a position now (matched with seller's ask)
      const position = await perps.read.getUserPosition([buyer2.account.address]);
      expect(position.netQuantity).to.equal(qty);
      // Position should be at the maker's price (marketPrice + tick), not the taker's price
      expect(position.aggregatedEntryPrice).to.equal(marketPrice + tick);
      expect(orderMatchedEvent.args.buyer).to.equal(getAddress(buyer2.account.address));
    });

    it("should match sell order with higher-priced buy orders", async function () {
      const { contracts, accounts, config } = await loadFixture(deployPerpsWithOrdersFixture);
      const { perps } = contracts;
      const { marketPrice, qty } = config;
      const tick = config.minimumPriceIncrement;

      // Best bid is at marketPrice - tick
      // Place a sell order at marketPrice - 2*tick (should match with best bid)
      const sellPrice = marketPrice - 2n * tick;

      // Seller already has sell orders, let's use buyer2 as a new seller
      const { buyer2 } = accounts;
      await perps.write.createOrder([sellPrice, -qty], {
        account: buyer2.account,
      });

      // Buyer2 should have a short position now (matched with buyer's bid)
      const position = await perps.read.getUserPosition([buyer2.account.address]);
      expect(position.netQuantity).to.equal(-qty);
      // Position should be at the maker's price (marketPrice - tick)
      expect(position.aggregatedEntryPrice).to.equal(marketPrice - tick);
    });

    it("should partially match and leave remaining as resting order", async function () {
      const { contracts, accounts, config } = await loadFixture(deployPerpsWithOrdersFixture);
      const { perps } = contracts;
      const { buyer2 } = accounts;
      const { marketPrice, qty } = config;
      const tick = config.minimumPriceIncrement;

      // Place a buy order for 2 units at best ask price
      const buyPrice = marketPrice + tick;
      const largeQty = qty * 2n;

      await perps.write.createOrder([buyPrice, largeQty], {
        account: buyer2.account,
      });

      // Should have matched 1 unit, and 1 unit remaining as order
      const position = await perps.read.getUserPosition([buyer2.account.address]);
      expect(position.netQuantity).to.equal(qty);

      const orders = await perps.read.getUserOrders([buyer2.account.address]);
      expect(orders.length).to.equal(1);

      const remainingOrder = await perps.read.getOrder([orders[0]]);
      expect(remainingOrder.quantity).to.equal(qty);
    });
  });

  describe("Self-Order Offset", function () {
    it("should offset own opposite orders at matching prices", async function () {
      const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const price = marketPrice;
      const qty = parseUnits("1", config.quantityDecimals);

      // Place a buy order
      await perps.write.createOrder([price, qty], {
        account: buyer.account,
      });

      let orders = await perps.read.getUserOrders([buyer.account.address]);
      expect(orders.length).to.equal(1);

      // Place a sell order at same price - should offset
      await perps.write.createOrder([price, -qty], {
        account: buyer.account,
      });

      // Orders should be canceled out
      orders = await perps.read.getUserOrders([buyer.account.address]);
      expect(orders.length).to.equal(0);

      // No position should be created (just offset)
      const position = await perps.read.getUserPosition([buyer.account.address]);
      expect(position.netQuantity).to.equal(0n);
    });

    it("should partially offset own orders", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const price = marketPrice;
      const qty = parseUnits("2", 6);
      const halfQty = parseUnits("1", 6);

      // Place a buy order for 2 units
      await perps.write.createOrder([price, qty], {
        account: buyer.account,
      });

      // Place a sell order for 1 unit at same price - should partially offset
      await perps.write.createOrder([price, -BigInt(halfQty)], {
        account: buyer.account,
      });

      // Should have 1 unit remaining
      const orders = await perps.read.getUserOrders([buyer.account.address]);
      expect(orders.length).to.equal(1);

      const order = await perps.read.getOrder([orders[0]]);
      expect(order.quantity).to.equal(BigInt(halfQty));
    });
  });

  describe("Margin Requirements", function () {
    it("should revert when insufficient margin for order", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      // Very large quantity that exceeds available collateral
      // At $84,524 price with 10% margin, 1000 BTC would need $8.4M margin
      const quantity = parseUnits("1000", 6); // 1000 BTC - way more than 50k collateral can support

      await expect(
        perps.write.createOrder([marketPrice, BigInt(quantity)], {
          account: buyer.account,
        })
      ).to.be.rejectedWith("InsufficientMargin");
    });
  });

  describe("Order Fee", function () {
    it("should deduct order fee when creating order", async function () {
      const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      const balanceBefore = await perps.read.balanceOf([buyer.account.address]);
      const marketPrice = await perps.read.getMarketPrice();
      const quantity = parseUnits("1", 6);

      await perps.write.createOrder(
        [marketPrice - config.minimumPriceIncrement, BigInt(quantity)],
        { account: buyer.account }
      );

      const balanceAfter = await perps.read.balanceOf([buyer.account.address]);
      expect(balanceBefore - balanceAfter).to.equal(config.orderFee);
    });
  });

  describe("Max Orders Limit", function () {
    it("should revert when max orders per participant reached", async function () {
      const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const tick = config.minimumPriceIncrement;
      const quantity = parseUnits("0.01", 6); // Small quantity to not run out of margin

      // Create 100 orders (max limit)
      for (let i = 1; i <= 100; i++) {
        await perps.write.createOrder([marketPrice - BigInt(i) * tick, BigInt(quantity)], {
          account: buyer.account,
        });
      }

      // 101st order should fail
      await expect(
        perps.write.createOrder([marketPrice - 101n * tick, BigInt(quantity)], {
          account: buyer.account,
        })
      ).to.be.rejectedWith("MaxOrdersPerParticipantReached");
    });
  });
});
