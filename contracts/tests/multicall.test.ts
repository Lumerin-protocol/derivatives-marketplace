import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits, getAddress, encodeFunctionData, zeroAddress } from "viem";
import { deployPerpsWithCollateralFixture, deployPerpsWithOrdersFixture } from "./fixtures.ts";

const { viem, networkHelpers } = await network.connect();

describe("PerpsSimple - multicall", function () {
  describe("Batch Create Orders", function () {
    it("should create multiple orders in a single transaction", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(
        deployPerpsWithCollateralFixture,
      );
      const { perps } = contracts;
      const { buyer } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const tick = config.minimumPriceIncrement;
      const qty = parseUnits("1", config.quantityDecimals);

      const calls = [
        encodeFunctionData({ abi: perps.abi, functionName: "createOrder", args: [marketPrice - tick, qty] }),
        encodeFunctionData({ abi: perps.abi, functionName: "createOrder", args: [marketPrice - 2n * tick, qty] }),
        encodeFunctionData({ abi: perps.abi, functionName: "createOrder", args: [marketPrice - 3n * tick, qty] }),
      ];

      await perps.write.multicall([calls], { account: buyer.account });

      const orders = await perps.read.getUserOrders([buyer.account.address]);
      assert.equal(orders.length, 3);
    });

    it("should create orders on both sides in a single transaction", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(
        deployPerpsWithCollateralFixture,
      );
      const { perps } = contracts;
      const { buyer } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const tick = config.minimumPriceIncrement;
      const qty = parseUnits("1", config.quantityDecimals);

      const calls = [
        encodeFunctionData({ abi: perps.abi, functionName: "createOrder", args: [marketPrice - tick, qty] }),
        encodeFunctionData({ abi: perps.abi, functionName: "createOrder", args: [marketPrice + tick, -qty] }),
      ];

      await perps.write.multicall([calls], { account: buyer.account });

      const orders = await perps.read.getUserOrders([buyer.account.address]);
      assert.equal(orders.length, 2);

      const order0 = await perps.read.getOrder([orders[0]]);
      const order1 = await perps.read.getOrder([orders[1]]);
      const quantities = [order0.quantity, order1.quantity].sort();
      assert.equal(quantities[0], -qty);
      assert.equal(quantities[1], qty);
    });
  });

  describe("Batch Cancel Orders", function () {
    it("should cancel multiple orders in a single transaction", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(
        deployPerpsWithOrdersFixture,
      );
      const { perps } = contracts;
      const { buyer } = accounts;

      const ordersBefore = await perps.read.getUserOrders([buyer.account.address]);
      assert.equal(ordersBefore.length, 3);

      const calls = ordersBefore.map((orderId) =>
        encodeFunctionData({ abi: perps.abi, functionName: "cancelOrder", args: [orderId] }),
      );

      await perps.write.multicall([calls], { account: buyer.account });

      const ordersAfter = await perps.read.getUserOrders([buyer.account.address]);
      assert.equal(ordersAfter.length, 0);
    });

    it("should free margin after batch cancel", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(
        deployPerpsWithOrdersFixture,
      );
      const { perps } = contracts;
      const { buyer } = accounts;

      const marginBefore = await perps.read.getRequiredMargin([buyer.account.address]);
      assert.ok(marginBefore > 0n);

      const orderIds = await perps.read.getUserOrders([buyer.account.address]);
      const calls = orderIds.map((orderId) =>
        encodeFunctionData({ abi: perps.abi, functionName: "cancelOrder", args: [orderId] }),
      );

      await perps.write.multicall([calls], { account: buyer.account });

      const marginAfter = await perps.read.getRequiredMargin([buyer.account.address]);
      assert.equal(marginAfter, 0n);
    });
  });

  describe("Mixed Batch (cancel + create)", function () {
    it("should cancel old orders and place new ones atomically", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(
        deployPerpsWithOrdersFixture,
      );
      const { perps } = contracts;
      const { buyer } = accounts;
      const { marketPrice } = config;
      const tick = config.minimumPriceIncrement;
      const qty = parseUnits("1", config.quantityDecimals);

      const existingOrders = await perps.read.getUserOrders([buyer.account.address]);
      assert.equal(existingOrders.length, 3);

      const cancelCalls = existingOrders.map((orderId) =>
        encodeFunctionData({ abi: perps.abi, functionName: "cancelOrder", args: [orderId] }),
      );
      const createCalls = [
        encodeFunctionData({ abi: perps.abi, functionName: "createOrder", args: [marketPrice - 4n * tick, qty] }),
        encodeFunctionData({ abi: perps.abi, functionName: "createOrder", args: [marketPrice - 5n * tick, qty] }),
      ];

      await perps.write.multicall([[...cancelCalls, ...createCalls]], { account: buyer.account });

      const newOrders = await perps.read.getUserOrders([buyer.account.address]);
      assert.equal(newOrders.length, 2);

      for (const orderId of newOrders) {
        const order = await perps.read.getOrder([orderId]);
        assert.equal(getAddress(order.participant), getAddress(buyer.account.address));
        assert.equal(order.quantity, qty);
      }
    });
  });

  describe("Atomicity", function () {
    it("should revert all operations if one sub-call fails", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(
        deployPerpsWithCollateralFixture,
      );
      const { perps } = contracts;
      const { buyer } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const tick = config.minimumPriceIncrement;
      const qty = parseUnits("1", config.quantityDecimals);

      const calls = [
        encodeFunctionData({ abi: perps.abi, functionName: "createOrder", args: [marketPrice - tick, qty] }),
        encodeFunctionData({ abi: perps.abi, functionName: "createOrder", args: [0n, qty] }), // invalid price → reverts
      ];

      await assert.rejects(
        perps.write.multicall([calls], { account: buyer.account }),
      );

      const orders = await perps.read.getUserOrders([buyer.account.address]);
      assert.equal(orders.length, 0, "first order should be rolled back");
    });

    it("should revert batch cancel if one order belongs to another user", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(
        deployPerpsWithOrdersFixture,
      );
      const { perps } = contracts;
      const { buyer, seller } = accounts;

      const buyerOrders = await perps.read.getUserOrders([buyer.account.address]);
      const sellerOrders = await perps.read.getUserOrders([seller.account.address]);

      const calls = [
        encodeFunctionData({ abi: perps.abi, functionName: "cancelOrder", args: [buyerOrders[0]] }),
        encodeFunctionData({ abi: perps.abi, functionName: "cancelOrder", args: [sellerOrders[0]] }), // not buyer's order
      ];

      await assert.rejects(
        perps.write.multicall([calls], { account: buyer.account }),
      );

      const buyerOrdersAfter = await perps.read.getUserOrders([buyer.account.address]);
      assert.equal(buyerOrdersAfter.length, buyerOrders.length, "no orders should have been cancelled");
    });
  });

  describe("msg.sender preservation", function () {
    it("should attribute all orders to the caller", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(
        deployPerpsWithCollateralFixture,
      );
      const { perps } = contracts;
      const { seller } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const tick = config.minimumPriceIncrement;
      const qty = parseUnits("1", config.quantityDecimals);

      const calls = [
        encodeFunctionData({ abi: perps.abi, functionName: "createOrder", args: [marketPrice + tick, -qty] }),
        encodeFunctionData({ abi: perps.abi, functionName: "createOrder", args: [marketPrice + 2n * tick, -qty] }),
      ];

      await perps.write.multicall([calls], { account: seller.account });

      const orders = await perps.read.getUserOrders([seller.account.address]);
      assert.equal(orders.length, 2);

      for (const orderId of orders) {
        const order = await perps.read.getOrder([orderId]);
        assert.equal(getAddress(order.participant), getAddress(seller.account.address));
      }
    });
  });

  describe("Gas savings", function () {
    it("should use less gas than individual transactions for multiple creates", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(
        deployPerpsWithCollateralFixture,
      );
      const { perps } = contracts;
      const { buyer, seller, pc } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const tick = config.minimumPriceIncrement;
      const qty = parseUnits("0.5", config.quantityDecimals);

      // Individual transactions
      let individualGas = 0n;
      for (let i = 1; i <= 3; i++) {
        const hash = await perps.write.createOrder(
          [marketPrice - BigInt(i) * tick, qty],
          { account: buyer.account },
        );
        const receipt = await pc.waitForTransactionReceipt({ hash });
        individualGas += receipt.gasUsed;
      }

      // Batch via multicall (use seller to avoid collateral overlap)
      const calls = [1, 2, 3].map((i) =>
        encodeFunctionData({
          abi: perps.abi,
          functionName: "createOrder",
          args: [marketPrice + BigInt(i) * tick, -qty],
        }),
      );

      const batchHash = await perps.write.multicall([calls], { account: seller.account });
      const batchReceipt = await pc.waitForTransactionReceipt({ hash: batchHash });
      const batchGas = batchReceipt.gasUsed;

      assert.ok(
        batchGas < individualGas,
        `multicall (${batchGas}) should use less gas than individual txs (${individualGas})`,
      );
    });
  });
});
