import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits, getAddress, parseEventLogs } from "viem";
import {
  deployPerpsWithCollateralFixture,
  deployPerpsWithOrdersFixture,
  deployPerpsWithLiquidatablePositionFixture,
} from "./fixtures.ts";

const { viem, networkHelpers } = await network.connect();

describe("HashPowerPerpsDEX - createOrder", function () {
  describe("Order Creation", function () {
    it("should create a buy order successfully", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(
        deployPerpsWithCollateralFixture,
      );
      const { perps } = contracts;
      const { buyer } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const price = marketPrice - config.minimumPriceIncrement;
      const quantity = parseUnits("1", 6);

      await perps.write.createOrder([price, quantity], { account: buyer.account });

      const orders = await perps.read.getUserOrders([buyer.account.address]);
      assert.equal(orders.length, 1);

      const order = await perps.read.getOrder([orders[0]]);
      assert.equal(order.price, price);
      assert.equal(order.quantity, quantity);
      assert.equal(getAddress(order.participant), getAddress(buyer.account.address));
    });

    it("should create a sell order successfully", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(
        deployPerpsWithCollateralFixture,
      );
      const { perps } = contracts;
      const { seller } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const price = marketPrice + config.minimumPriceIncrement;
      const quantity = parseUnits("1", config.quantityDecimals);

      await perps.write.createOrder([price, -quantity], { account: seller.account });

      const orders = await perps.read.getUserOrders([seller.account.address]);
      assert.equal(orders.length, 1);

      const order = await perps.read.getOrder([orders[0]]);
      assert.equal(order.price, price);
      assert.equal(order.quantity, -BigInt(quantity));
    });

    it("should revert on zero quantity", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(
        deployPerpsWithCollateralFixture,
      );
      const { perps } = contracts;
      const { buyer } = accounts;

      const marketPrice = await perps.read.getMarketPrice();

      await viem.assertions.revertWithCustomError(
        perps.write.createOrder([marketPrice, 0n], { account: buyer.account }),
        perps,
        "InvalidSize",
      );
    });

    it("should revert on zero price", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(
        deployPerpsWithCollateralFixture,
      );
      const { perps } = contracts;
      const { buyer } = accounts;

      const quantity = parseUnits("1", config.quantityDecimals);

      await viem.assertions.revertWithCustomError(
        perps.write.createOrder([0n, quantity], { account: buyer.account }),
        perps,
        "InvalidPrice",
      );
    });

    it("should revert when price is not a multiple of minimumPriceIncrement", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(
        deployPerpsWithCollateralFixture,
      );
      const { perps } = contracts;
      const { buyer } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const invalidPrice = marketPrice + config.minimumPriceIncrement / 2n;
      const quantity = parseUnits("1", config.quantityDecimals);

      await viem.assertions.revertWithCustomError(
        perps.write.createOrder([invalidPrice, quantity], { account: buyer.account }),
        perps,
        "InvalidPrice",
      );
    });
  });

  describe("Limit Price Matching", function () {
    it("should match buy order with lower-priced sell orders", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(
        deployPerpsWithOrdersFixture,
      );
      const { perps } = contracts;
      const { buyer2, pc } = accounts;
      const { marketPrice, qty } = config;
      const tick = config.minimumPriceIncrement;

      const buyPrice = marketPrice + 2n * tick;

      const hash = await perps.write.createOrder([buyPrice, qty], { account: buyer2.account });
      const receipt = await pc.waitForTransactionReceipt({ hash });

      const [orderMatchedEvent] = parseEventLogs({
        logs: receipt.logs,
        abi: perps.abi,
        eventName: "OrderMatched",
      });

      const position = await perps.read.getUserPosition([buyer2.account.address]);
      assert.equal(position.netQuantity, qty);
      assert.equal(position.aggregatedEntryPrice, marketPrice + tick);
      assert.equal(orderMatchedEvent.args.taker, getAddress(buyer2.account.address));
    });

    it("should match sell order with higher-priced buy orders", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(
        deployPerpsWithOrdersFixture,
      );
      const { perps } = contracts;
      const { marketPrice, qty } = config;
      const tick = config.minimumPriceIncrement;

      const sellPrice = marketPrice - 2n * tick;

      const { buyer2 } = accounts;
      await perps.write.createOrder([sellPrice, -qty], { account: buyer2.account });

      const position = await perps.read.getUserPosition([buyer2.account.address]);
      assert.equal(position.netQuantity, -qty);
      assert.equal(position.aggregatedEntryPrice, marketPrice - tick);
    });

    it("should partially match and leave remaining as resting order", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(
        deployPerpsWithOrdersFixture,
      );
      const { perps } = contracts;
      const { buyer2 } = accounts;
      const { marketPrice, qty } = config;
      const tick = config.minimumPriceIncrement;

      const buyPrice = marketPrice + tick;
      const largeQty = qty * 2n;

      await perps.write.createOrder([buyPrice, largeQty], { account: buyer2.account });

      const position = await perps.read.getUserPosition([buyer2.account.address]);
      assert.equal(position.netQuantity, qty);

      const orders = await perps.read.getUserOrders([buyer2.account.address]);
      assert.equal(orders.length, 1);

      const remainingOrder = await perps.read.getOrder([orders[0]]);
      assert.equal(remainingOrder.quantity, qty);
    });

    it("should emit OrderCreated with original qty then OrderUpdated after partial fill", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(
        deployPerpsWithOrdersFixture,
      );
      const { perps } = contracts;
      const { buyer2, pc } = accounts;
      const { marketPrice, qty } = config;
      const tick = config.minimumPriceIncrement;

      const buyPrice = marketPrice + tick;
      const originalQty = qty * 2n;

      const hash = await perps.write.createOrder([buyPrice, originalQty], {
        account: buyer2.account,
      });
      const receipt = await pc.waitForTransactionReceipt({ hash });

      const orderCreatedEvents = parseEventLogs({
        logs: receipt.logs,
        abi: perps.abi,
        eventName: "OrderCreated",
      });

      assert.equal(orderCreatedEvents.length, 1, "expected exactly one OrderCreated event");

      const [created] = orderCreatedEvents;
      assert.equal(created.args.participant, getAddress(buyer2.account.address));
      assert.equal(created.args.price, buyPrice);
      assert.equal(
        created.args.quantity,
        originalQty,
        "OrderCreated should carry the original quantity, not the remainder",
      );

      const orderUpdatedEvents = parseEventLogs({
        logs: receipt.logs,
        abi: perps.abi,
        eventName: "OrderUpdated",
        args: {
          orderId: created.args.orderId,
        },
      });

      assert.equal(
        orderUpdatedEvents.length,
        1,
        "expected OrderUpdated after partial fill reduces the taker order",
      );
      assert.equal(
        orderUpdatedEvents[0].args.newQuantity,
        qty,
        "OrderUpdated should carry the remaining quantity",
      );
    });
  });

  describe("Self-Trade Prevention", function () {
    it("should net out own opposite orders at matching prices without a fill", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(
        deployPerpsWithCollateralFixture,
      );
      const { perps } = contracts;
      const { buyer } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const price = marketPrice;
      const qty = parseUnits("1", config.quantityDecimals);

      await perps.write.createOrder([price, qty], { account: buyer.account });

      let orders = await perps.read.getUserOrders([buyer.account.address]);
      assert.equal(orders.length, 1);

      await perps.write.createOrder([price, -qty], { account: buyer.account });

      orders = await perps.read.getUserOrders([buyer.account.address]);
      assert.equal(orders.length, 0);

      const position = await perps.read.getUserPosition([buyer.account.address]);
      assert.equal(position.netQuantity, 0n);
    });

    it("should partially net out own orders without a fill", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(
        deployPerpsWithCollateralFixture,
      );
      const { perps } = contracts;
      const { buyer } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const price = marketPrice;
      const qty = parseUnits("2", 6);
      const halfQty = parseUnits("1", 6);

      await perps.write.createOrder([price, qty], { account: buyer.account });
      await perps.write.createOrder([price, -BigInt(halfQty)], { account: buyer.account });

      const orders = await perps.read.getUserOrders([buyer.account.address]);
      assert.equal(orders.length, 1);

      const order = await perps.read.getOrder([orders[0]]);
      assert.equal(order.quantity, BigInt(halfQty));
    });
  });

  describe("Margin Requirements", function () {
    it("should revert when insufficient margin for order", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(
        deployPerpsWithCollateralFixture,
      );
      const { perps } = contracts;
      const { buyer } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const maxQuantity =
        (config.collateralPerUser * 100n * 10n ** BigInt(config.quantityDecimals)) /
        (marketPrice * BigInt(config.marginPercent));
      const quantity = maxQuantity * 2n;

      await viem.assertions.revertWithCustomError(
        perps.write.createOrder([marketPrice, BigInt(quantity)], { account: buyer.account }),
        perps,
        "InsufficientMargin",
      );
    });

    it("should allow reduce-only order when margin is tight", async function () {
      const data = await networkHelpers.loadFixture(deployPerpsWithLiquidatablePositionFixture);
      const { contracts, accounts, config } = data;
      const { perps, priceOracle } = contracts;
      const { seller } = accounts;

      // Move price against the short seller (up) so margin is tight but not liquidatable
      const tick = config.minimumPriceIncrement;
      const priceIncrease = tick * 200n;
      const newPrice = config.initialPrice + priceIncrease;
      await priceOracle.write.setPrice([newPrice, config.oracle.decimals]);

      // Verify seller is in the buffer zone: above maintenance (5%) but below initial (10%)
      const balance = await perps.read.balanceOf([seller.account.address]);
      const maintenanceMargin = await perps.read.getMaintenanceMargin([seller.account.address]);
      assert.ok(balance > maintenanceMargin, "balance should be above maintenance margin");
      assert.ok(
        !(await perps.read.isLiquidatable([seller.account.address])),
        "seller should not be liquidatable",
      );

      // Closing buy order (reduce-only) should succeed even though a resting order
      // would push total margin above collateral balance
      const closingPrice = config.initialPrice - tick * 10n;
      await perps.write.createOrder([closingPrice, config.qty], { account: seller.account });

      const orders = await perps.read.getUserOrders([seller.account.address]);
      assert.equal(orders.length, 1, "closing order should be resting on the book");
    });

    it("should not become liquidatable after placing a reduce-only order", async function () {
      const data = await networkHelpers.loadFixture(deployPerpsWithLiquidatablePositionFixture);
      const { contracts, accounts, config } = data;
      const { perps, priceOracle } = contracts;
      const { seller } = accounts;

      // Move price against seller enough that adding a resting closing order's value
      // to userTotalOrderValue would push maintenance margin above collateral balance
      const tick = config.minimumPriceIncrement;
      const priceIncrease = tick * 220n;
      const newPrice = config.initialPrice + priceIncrease;
      await priceOracle.write.setPrice([newPrice, config.oracle.decimals]);

      // Verify seller is in the buffer zone and not liquidatable
      const balance = await perps.read.balanceOf([seller.account.address]);
      const maintenanceMargin = await perps.read.getMaintenanceMargin([seller.account.address]);
      assert.ok(balance > maintenanceMargin, "balance should be above maintenance margin");
      assert.ok(
        !(await perps.read.isLiquidatable([seller.account.address])),
        "seller should not be liquidatable before closing order",
      );

      // Place a reduce-only closing order at a price that will rest
      const closingPrice = config.initialPrice - tick * 10n;
      await perps.write.createOrder([closingPrice, config.qty], { account: seller.account });

      // The resting closing order should NOT push the user into liquidation
      assert.ok(
        !(await perps.read.isLiquidatable([seller.account.address])),
        "seller should not be liquidatable after placing reduce-only closing order",
      );
    });

    it("should reject position-increasing order when margin is tight", async function () {
      const data = await networkHelpers.loadFixture(deployPerpsWithLiquidatablePositionFixture);
      const { contracts, accounts, config } = data;
      const { perps, priceOracle } = contracts;
      const { seller } = accounts;

      const tick = config.minimumPriceIncrement;
      const priceIncrease = tick * 200n;
      const newPrice = config.initialPrice + priceIncrease;
      await priceOracle.write.setPrice([newPrice, config.oracle.decimals]);

      // Verify seller is in the buffer zone: above maintenance (5%) but below initial (10%)
      const balance = await perps.read.balanceOf([seller.account.address]);
      const maintenanceMargin = await perps.read.getMaintenanceMargin([seller.account.address]);
      assert.ok(balance > maintenanceMargin, "balance should be above maintenance margin");
      assert.ok(
        !(await perps.read.isLiquidatable([seller.account.address])),
        "seller should not be liquidatable",
      );

      // Adding to short position should fail — same side, not reduce-only
      await viem.assertions.revertWithCustomError(
        perps.write.createOrder([newPrice + tick, -config.qty], { account: seller.account }),
        perps,
        "InsufficientMargin",
      );
    });

    it("should reject order exceeding position size even if opposite side", async function () {
      const data = await networkHelpers.loadFixture(deployPerpsWithLiquidatablePositionFixture);
      const { contracts, accounts, config } = data;
      const { perps, priceOracle } = contracts;
      const { seller } = accounts;

      const tick = config.minimumPriceIncrement;
      const priceIncrease = tick * 200n;
      const newPrice = config.initialPrice + priceIncrease;
      await priceOracle.write.setPrice([newPrice, config.oracle.decimals]);

      // Verify seller is in the buffer zone: above maintenance (5%) but below initial (10%)
      const balance = await perps.read.balanceOf([seller.account.address]);
      const maintenanceMargin = await perps.read.getMaintenanceMargin([seller.account.address]);
      assert.ok(balance > maintenanceMargin, "balance should be above maintenance margin");
      assert.ok(
        !(await perps.read.isLiquidatable([seller.account.address])),
        "seller should not be liquidatable",
      );

      // Buy order larger than position — would flip to long, not reduce-only
      const closingPrice = config.initialPrice - tick * 10n;
      await viem.assertions.revertWithCustomError(
        perps.write.createOrder([closingPrice, config.qty * 2n], { account: seller.account }),
        perps,
        "InsufficientMargin",
      );
    });
  });

  describe("Match Fees", function () {
    it("should not deduct fee when order rests (no match)", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(
        deployPerpsWithCollateralFixture,
      );
      const { perps } = contracts;
      const { buyer } = accounts;

      const balanceBefore = await perps.read.balanceOf([buyer.account.address]);
      const marketPrice = await perps.read.getMarketPrice();
      const quantity = parseUnits("1", 6);

      await perps.write.createOrder(
        [marketPrice - config.minimumPriceIncrement, BigInt(quantity)],
        { account: buyer.account },
      );

      const balanceAfter = await perps.read.balanceOf([buyer.account.address]);
      assert.equal(balanceBefore - balanceAfter, 0n);
    });

    it("should charge taker fee on match with liquidationFee as floor", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(
        deployPerpsWithCollateralFixture,
      );
      const { perps } = contracts;
      const { buyer, seller } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const quantity = parseUnits("1", config.quantityDecimals);

      await perps.write.createOrder([marketPrice, -quantity], { account: seller.account });

      const balanceBefore = await perps.read.balanceOf([buyer.account.address]);

      await perps.write.createOrder([marketPrice, quantity], { account: buyer.account });

      const balanceAfter = await perps.read.balanceOf([buyer.account.address]);
      const notionalValue = (marketPrice * quantity) / 10n ** BigInt(config.quantityDecimals);
      const expectedFee = (notionalValue * config.takerFeeBps) / 10000n;

      assert.equal(balanceBefore - balanceAfter, expectedFee);
    });

    it("should not charge maker fee when makerFeeBps is 0", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(
        deployPerpsWithCollateralFixture,
      );
      const { perps } = contracts;
      const { buyer, seller, owner } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const quantity = parseUnits("1", config.quantityDecimals);
      const feeBps = 0;

      await perps.write.setMakerFeeBps([feeBps], { account: owner.account });
      await perps.write.setTakerFeeBps([feeBps], { account: owner.account });

      await perps.write.createOrder([marketPrice, -quantity], { account: seller.account });

      const sellerBalanceBefore = await perps.read.balanceOf([seller.account.address]);

      await perps.write.createOrder([marketPrice, quantity], { account: buyer.account });

      const sellerBalanceAfter = await perps.read.balanceOf([seller.account.address]);

      assert.equal(sellerBalanceBefore, sellerBalanceAfter);
    });
  });

  describe("Max Orders Limit", function () {
    it("should revert when max orders per participant reached", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(
        deployPerpsWithCollateralFixture,
      );
      const { perps } = contracts;
      const { buyer } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const tick = config.minimumPriceIncrement;
      const quantity = parseUnits("0.01", 6);

      for (let i = 1; i <= 100; i++) {
        await perps.write.createOrder([marketPrice - BigInt(i) * tick, BigInt(quantity)], {
          account: buyer.account,
        });
      }

      await viem.assertions.revertWithCustomError(
        perps.write.createOrder([marketPrice - 101n * tick, BigInt(quantity)], {
          account: buyer.account,
        }),
        perps,
        "MaxOrdersPerParticipantReached",
      );
    });
  });
});
