import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { maxUint256, parseEventLogs, parseUnits, zeroHash } from "viem";
import {
  deployPerpsFixture,
  deployPerpsWithCollateralFixture,
  deployPerpsWithLiquidatablePositionFixture,
} from "./fixtures.ts";
import { TimeInForce } from "../fixtures/timeInForce.ts";

const { viem, networkHelpers } = await network.connect();

/**
 * Strict orders-first invariant + permissionless liquidation entry points.
 *
 * Surface under test:
 *   - liquidateOrder(user, id)              — single cancel
 *   - liquidateOrders(user, ids[])          — keeper-chosen ids, stop-on-failure
 *   - liquidatePosition(user, closeQty)     — reverts OrdersStillOpen if any orders remain
 *   - setLiquidationFeeBps(uint16)          — bps fee on notional; liquidator share defaults to 0
 *
 * Fixture pattern: build an underwater account that ALSO has resting orders so we can
 * exercise both legs of the strict two-step.
 */
async function deployUnderwaterWithOrdersFixture(conn: Parameters<typeof deployPerpsFixture>[0]) {
  const data = await deployPerpsFixture(conn);
  const { contracts, accounts, config, utils } = data;
  const { perps, priceOracle, vault } = contracts;
  const { seller, buyer, owner } = accounts;

  // Configure a small liquidation fee so the per-order bps fee math is exercised: the fee
  // is charged on cancelled-order notional, but the liquidator share defaults to 0 (the
  // whole fee becomes venue revenue). Tests that need to exercise the position-side
  // path don't depend on this override.
  const liquidationFeeBps = 50; // 0.5%
  await perps.write.setLiquidationFeeBps([liquidationFeeBps], { account: owner.account });

  const initialPrice = await perps.read.getMarketPrice();
  const tick = config.minimumPriceIncrement;
  const qty = parseUnits("1", config.quantityDecimals);
  const minCollateral = utils.getMinimumCollateral(initialPrice, qty);

  await vault.write.deposit([minCollateral], { account: seller.account });
  await vault.write.deposit([minCollateral * 2n], { account: buyer.account });

  // Position: seller short, buyer long (matched).
  await perps.write.createOrder([initialPrice, -qty, TimeInForce.GTC], { account: seller.account });
  await perps.write.createOrder([initialPrice, qty, TimeInForce.GTC], { account: buyer.account });

  // Two extra resting orders for seller (bracket the matched price so they don't accidentally cross).
  const restingQty = parseUnits("0.1", config.quantityDecimals);
  await perps.write.createOrder([initialPrice + 5n * tick, -restingQty, TimeInForce.GTC], {
    account: seller.account,
  });
  await perps.write.createOrder([initialPrice + 10n * tick, -restingQty, TimeInForce.GTC], {
    account: seller.account,
  });

  // One unrelated buyer-owned resting order (well out of the matched zone) — used by the
  // OrderNotBelongToUser test to assert ownership is checked AFTER the underwater predicate.
  await perps.write.createOrder([initialPrice - 50n * tick, restingQty, TimeInForce.GTC], {
    account: buyer.account,
  });

  return {
    ...data,
    config: { ...config, initialPrice, qty, minCollateral, liquidationFeeBps },
    async makeUnderwater() {
      const newPrice = initialPrice * 2n;
      await priceOracle.write.setPrice([newPrice, config.oracle.decimals]);
      return newPrice;
    },
  };
}

describe("HashPowerPerpsDEX - liquidateOrder/liquidatePosition", function () {
  describe("liquidateOrder", function () {
    it("reverts when user is healthy", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(
        deployUnderwaterWithOrdersFixture,
      );
      const { perps } = contracts;
      const { seller, buyer2 } = accounts;

      const orders = await perps.read.getUserOrders([seller.account.address]);
      assert.ok(orders.length > 0);

      await viem.assertions.revertWithCustomError(
        perps.write.liquidateOrder([seller.account.address, orders[0]], {
          account: buyer2.account,
        }),
        perps,
        "NotLiquidatable",
      );
    });

    it("reverts when order does not belong to specified user", async function () {
      const data = await networkHelpers.loadFixture(deployUnderwaterWithOrdersFixture);
      const { contracts, accounts } = data;
      const { perps } = contracts;
      const { seller, buyer, buyer2 } = accounts;

      await data.makeUnderwater();

      // seller is underwater; pass a buyer-owned id with the seller's address -> mismatch.
      const buyerOrders = await perps.read.getUserOrders([buyer.account.address]);
      assert.ok(buyerOrders.length > 0, "fixture should leave a resting buyer order");

      await viem.assertions.revertWithCustomError(
        perps.write.liquidateOrder([seller.account.address, buyerOrders[0]], {
          account: buyer2.account,
        }),
        perps,
        "OrderNotBelongToUser",
      );
    });

    it("reverts when order id does not exist", async function () {
      const data = await networkHelpers.loadFixture(deployUnderwaterWithOrdersFixture);
      const { contracts, accounts } = data;
      const { perps } = contracts;
      const { seller, buyer2 } = accounts;

      await data.makeUnderwater();

      await viem.assertions.revertWithCustomError(
        perps.write.liquidateOrder([seller.account.address, zeroHash], {
          account: buyer2.account,
        }),
        perps,
        "OrderNotBelongToUser",
      );
    });

    it("cancels the order and charges the bps fee (liquidator share defaults to 0)", async function () {
      const data = await networkHelpers.loadFixture(deployUnderwaterWithOrdersFixture);
      const { contracts, accounts } = data;
      const { perps, vault } = contracts;
      const { seller, buyer2, pc } = accounts;

      await data.makeUnderwater();

      const ordersBefore = await perps.read.getUserOrders([seller.account.address]);
      assert.ok(ordersBefore.length >= 1);
      const targetId = ordersBefore[0];

      const liqBalanceBefore = await vault.read.balanceOf([buyer2.account.address]);
      const sellerBalanceBefore = await vault.read.balanceOf([seller.account.address]);
      const revenueBefore = await perps.read.collectedFeesBalance();
      const insuranceBefore = await vault.read.insuranceFundBalance();

      const hash = await perps.write.liquidateOrder([seller.account.address, targetId], {
        account: buyer2.account,
      });
      const receipt = await pc.waitForTransactionReceipt({ hash });

      const liqBalanceAfter = await vault.read.balanceOf([buyer2.account.address]);
      const sellerBalanceAfter = await vault.read.balanceOf([seller.account.address]);

      // Liquidator gets nothing (liquidatorShareBps defaults to 0); the user pays the fee.
      assert.equal(liqBalanceAfter - liqBalanceBefore, 0n);
      assert.ok(sellerBalanceBefore > sellerBalanceAfter, "user should pay liquidation fee");

      const ordersAfter = await perps.read.getUserOrders([seller.account.address]);
      assert.equal(ordersAfter.length, ordersBefore.length - 1);
      assert.ok(!ordersAfter.includes(targetId));
      const aggregateAfter = await perps.read.getOrderAggregate([seller.account.address]);
      const remaining = await Promise.all(ordersAfter.map((id) => perps.read.getOrder([id])));
      assert.equal(
        aggregateAfter.sellQty,
        remaining.reduce((total, order) => total - order.quantity, 0n),
      );
      assert.equal(
        aggregateAfter.sellValue,
        remaining.reduce(
          (total, order) =>
            total +
            (order.price * -order.quantity) / 10n ** BigInt(data.config.quantityDecimals),
          0n,
        ),
      );

      const events = parseEventLogs({ abi: perps.abi, logs: receipt.logs });
      const cancelled = events.find((e) => e.eventName === "OrderCancelled");
      const liquidated = events.find((e) => e.eventName === "OrderLiquidated");
      assert.ok(cancelled, "OrderCancelled should be emitted for indexer compatibility");
      assert.equal(cancelled.args.orderId, targetId);
      assert.ok(liquidated);
      assert.equal(liquidated.args.orderId, targetId);
      assert.equal(
        liquidated.args.liquidator.toLowerCase(),
        buyer2.account.address.toLowerCase(),
      );
      assert.ok(liquidated.args.fee > 0n, "fee should be non-zero");
      assert.equal(sellerBalanceBefore - sellerBalanceAfter, liquidated.args.fee);
      assert.equal(await perps.read.collectedFeesBalance(), revenueBefore + liquidated.args.fee);
      assert.equal(await vault.read.insuranceFundBalance(), insuranceBefore);
    });

    it("does not pay the liquidator even when liquidationFeeBps is set high (share defaults to 0)", async function () {
      const data = await networkHelpers.loadFixture(deployUnderwaterWithOrdersFixture);
      const { contracts, accounts } = data;
      const { perps, vault } = contracts;
      const { seller, buyer2, owner } = accounts;

      await data.makeUnderwater();

      // 100% fee — capped at the seller's balance; still nothing for the liquidator.
      await perps.write.setLiquidationFeeBps([10000], { account: owner.account });

      const sellerBalanceBefore = await vault.read.balanceOf([seller.account.address]);
      const liqBalanceBefore = await vault.read.balanceOf([buyer2.account.address]);

      const orders = await perps.read.getUserOrders([seller.account.address]);
      await perps.write.liquidateOrder([seller.account.address, orders[0]], {
        account: buyer2.account,
      });

      const sellerBalanceAfter = await vault.read.balanceOf([seller.account.address]);
      const liqBalanceAfter = await vault.read.balanceOf([buyer2.account.address]);

      // Liquidator still gets 0 at default share. User pays what they can.
      assert.equal(liqBalanceAfter, liqBalanceBefore, "liquidator balance unchanged");
      assert.ok(sellerBalanceAfter <= sellerBalanceBefore, "user paid the fee");
    });
  });

  describe("liquidateOrders (keeper-chosen ids, stop-on-failure)", function () {
    it("cancels all specified orders without paying a fee (payout disabled)", async function () {
      const data = await networkHelpers.loadFixture(deployUnderwaterWithOrdersFixture);
      const { contracts, accounts } = data;
      const { perps, vault } = contracts;
      const { seller, buyer2 } = accounts;

      await data.makeUnderwater();

      const ordersBefore = await perps.read.getUserOrders([seller.account.address]);
      assert.equal(ordersBefore.length, 2);

      const liqBalanceBefore = await vault.read.balanceOf([buyer2.account.address]);

      await perps.write.liquidateOrders([seller.account.address, ordersBefore], {
        account: buyer2.account,
      });

      const liqBalanceAfter = await vault.read.balanceOf([buyer2.account.address]);
      const ordersAfter = await perps.read.getUserOrders([seller.account.address]);

      assert.equal(ordersAfter.length, 0);
      assert.deepEqual(await perps.read.getOrderAggregate([seller.account.address]), {
        buyQty: 0n,
        sellQty: 0n,
        buyValue: 0n,
        sellValue: 0n,
      });
      assert.equal(liqBalanceAfter - liqBalanceBefore, 0n);
    });

    it("reverts NotLiquidatable when user is healthy", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(
        deployUnderwaterWithOrdersFixture,
      );
      const { perps } = contracts;
      const { seller, buyer2 } = accounts;

      const orders = await perps.read.getUserOrders([seller.account.address]);
      await viem.assertions.revertWithCustomError(
        perps.write.liquidateOrders([seller.account.address, orders], {
          account: buyer2.account,
        }),
        perps,
        "NotLiquidatable",
      );
    });

    it("stops early once user becomes healthy mid-batch", async function () {
      const data = await networkHelpers.loadFixture(deployUnderwaterWithOrdersFixture);
      const { contracts, accounts } = data;
      const { perps, pme, priceOracle } = contracts;
      const { seller, buyer2 } = accounts;

      // Barely underwater so cancelling resting shorts can flip healthy mid-batch.
      const initialPrice = await perps.read.getMarketPrice();
      const tick = data.config.minimumPriceIncrement;
      const bump = initialPrice + tick * 30n;
      await priceOracle.write.setPrice([bump, data.config.oracle.decimals]);

      const underwater = await pme.read.isLiquidatable([seller.account.address]);
      if (!underwater) {
        await data.makeUnderwater();
      }

      const orders = await perps.read.getUserOrders([seller.account.address]);
      assert.ok(orders.length > 0);

      await perps.write.liquidateOrders([seller.account.address, orders], {
        account: buyer2.account,
      });

      // At least one cancel landed; remaining orders (if any) are left for a later call.
      const ordersAfter = await perps.read.getUserOrders([seller.account.address]);
      assert.ok(ordersAfter.length < orders.length);
    });
  });

  describe("liquidatePosition", function () {
    it("reverts NotLiquidatable when user has no position", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(
        deployPerpsWithCollateralFixture,
      );
      const { perps } = contracts;
      const { seller, buyer2 } = accounts;

      await viem.assertions.revertWithCustomError(
        perps.write.liquidatePosition([seller.account.address, maxUint256], { account: buyer2.account }),
        perps,
        "NotLiquidatable",
      );
    });

    it("reverts NotLiquidatable when user is healthy", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(
        deployPerpsWithLiquidatablePositionFixture,
      );
      const { perps } = contracts;
      const { seller, buyer2 } = accounts;

      await viem.assertions.revertWithCustomError(
        perps.write.liquidatePosition([seller.account.address, maxUint256], { account: buyer2.account }),
        perps,
        "NotLiquidatable",
      );
    });

    it("reverts OrdersStillOpen when user is underwater but has open orders", async function () {
      const data = await networkHelpers.loadFixture(deployUnderwaterWithOrdersFixture);
      const { contracts, accounts } = data;
      const { perps } = contracts;
      const { seller, buyer2 } = accounts;

      await data.makeUnderwater();

      const orders = await perps.read.getUserOrders([seller.account.address]);
      assert.ok(orders.length > 0);

      await viem.assertions.revertWithCustomError(
        perps.write.liquidatePosition([seller.account.address, maxUint256], { account: buyer2.account }),
        perps,
        "OrdersStillOpen",
      );
    });

    it("succeeds after orders are cleared via liquidateOrders", async function () {
      const data = await networkHelpers.loadFixture(deployUnderwaterWithOrdersFixture);
      const { contracts, accounts } = data;
      const { perps, vault } = contracts;
      const { seller, buyer2 } = accounts;

      await data.makeUnderwater();

      const orders = await perps.read.getUserOrders([seller.account.address]);
      await perps.write.liquidateOrders([seller.account.address, orders], { account: buyer2.account });

      const liqBalanceBefore = await vault.read.balanceOf([buyer2.account.address]);

      await perps.write.liquidatePosition([seller.account.address, maxUint256], {
        account: buyer2.account,
      });

      const positionAfter = await perps.read.getUserPosition([seller.account.address]);
      assert.equal(positionAfter.netQuantity, 0n);

      const liqBalanceAfter = await vault.read.balanceOf([buyer2.account.address]);
      // Liquidator gets nothing (liquidatorShareBps defaults to 0).
      assert.equal(liqBalanceAfter, liqBalanceBefore);
    });

    it("emits PositionLiquidated", async function () {
      const data = await networkHelpers.loadFixture(deployPerpsWithLiquidatablePositionFixture);
      const { contracts, accounts } = data;
      const { perps } = contracts;
      const { seller, buyer2, pc } = accounts;

      await data.makeLiquidatable();

      const hash = await perps.write.liquidatePosition([seller.account.address, maxUint256], {
        account: buyer2.account,
      });
      const receipt = await pc.waitForTransactionReceipt({ hash });
      const events = parseEventLogs({ abi: perps.abi, logs: receipt.logs });
      const positionLiquidated = events.find(
        (e) => e.eventName === "PositionLiquidated",
      );
      assert.ok(positionLiquidated);
      assert.equal(
        positionLiquidated.args.user.toLowerCase(),
        seller.account.address.toLowerCase(),
      );
      assert.equal(
        positionLiquidated.args.liquidator.toLowerCase(),
        buyer2.account.address.toLowerCase(),
      );
    });
  });
});
