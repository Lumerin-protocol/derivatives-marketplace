import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { encodeFunctionData, maxUint256, parseEventLogs, parseUnits, zeroHash } from "viem";
import type { Hex } from "viem";
import {
  deployPerpsFixture,
  deployPerpsWithCollateralFixture,
  deployPerpsWithLiquidatablePositionFixture,
} from "./fixtures.ts";

const { viem, networkHelpers } = await network.connect();

/**
 * Wrap `liquidatePosition(user)` in its own single-entry inner
 * `multicallStopOnFailure` so a per-user revert (`OrdersStillOpen`,
 * `NotLiquidatable`) is converted into a successful return — the outer
 * multicall keeps going to the next user. Same composition used by the keeper
 * (and by `liquidate.test.ts`) to express batched skip-and-continue.
 */
function encodeInnerLiquidatePosition(abi: readonly unknown[], user: `0x${string}`): Hex {
  return encodeFunctionData({
    abi,
    functionName: "multicallStopOnFailure",
    args: [
      [
        encodeFunctionData({
          abi,
          functionName: "liquidatePosition",
          // Full close (clamped to |netQty|) — this suite exercises complete liquidations.
          args: [user, maxUint256],
        }),
      ],
    ],
  });
}

/** Encode a `liquidateOrder(user, orderId)` sub-call for use inside `multicallStopOnFailure`. */
function encodeLiquidateOrder(abi: readonly unknown[], user: `0x${string}`, orderId: Hex): Hex {
  return encodeFunctionData({
    abi,
    functionName: "liquidateOrder",
    args: [user, orderId],
  });
}

/**
 * Strict orders-first invariant + permissionless liquidation entry points.
 *
 * Surface under test:
 *   - liquidateOrder(user, id)              — single cancel
 *   - liquidateOrders(user, ids[])          — keeper-chosen ids, stop-on-failure
 *   - liquidatePosition(user, closeQty)     — reverts OrdersStillOpen if any orders remain
 *   - nested multicallStopOnFailure         — per-user skip-and-continue batches
 *   - setLiquidationFee(uint256)            — retained; payout currently disabled
 *
 * Fixture pattern: build an underwater account that ALSO has resting orders so we can
 * exercise both legs of the strict two-step.
 */
async function deployUnderwaterWithOrdersFixture(conn: Parameters<typeof deployPerpsFixture>[0]) {
  const data = await deployPerpsFixture(conn);
  const { contracts, accounts, config, utils } = data;
  const { perps, priceOracle, vault } = contracts;
  const { seller, buyer, owner } = accounts;

  // Tighten the flat liquidation fee so the underwater seller's vault can cover the full
  // per-order fee on every cancel in the batch — keeps the `pays per-order fee` math exact.
  // Tests that need to exercise the position-side path don't depend on this override.
  const liquidationFee = parseUnits("0.5", config.tokenDecimals);
  await perps.write.setLiquidationFee([liquidationFee], { account: owner.account });

  const initialPrice = await perps.read.getMarketPrice();
  const tick = config.minimumPriceIncrement;
  const qty = parseUnits("1", config.quantityDecimals);
  const minCollateral = utils.getMinimumCollateral(initialPrice, qty);

  await vault.write.deposit([minCollateral], { account: seller.account });
  await vault.write.deposit([minCollateral * 2n], { account: buyer.account });

  // Position: seller short, buyer long (matched).
  await perps.write.createOrder([initialPrice, -qty], { account: seller.account });
  await perps.write.createOrder([initialPrice, qty], { account: buyer.account });

  // Two extra resting orders for seller (bracket the matched price so they don't accidentally cross).
  const restingQty = parseUnits("0.1", config.quantityDecimals);
  await perps.write.createOrder([initialPrice + 5n * tick, -restingQty], {
    account: seller.account,
  });
  await perps.write.createOrder([initialPrice + 10n * tick, -restingQty], {
    account: seller.account,
  });

  // One unrelated buyer-owned resting order (well out of the matched zone) — used by the
  // OrderNotBelongToUser test to assert ownership is checked AFTER the underwater predicate.
  await perps.write.createOrder([initialPrice - 50n * tick, restingQty], {
    account: buyer.account,
  });

  return {
    ...data,
    config: { ...config, initialPrice, qty, minCollateral, liquidationFee },
    async makeUnderwater() {
      const newPrice = initialPrice * 2n;
      await priceOracle.write.setPrice([newPrice, config.oracle.decimals]);
      return newPrice;
    },
  };
}

describe("HashPowerPerpsDEX - liquidateOrder/liquidatePosition (+ multicallStopOnFailure batches)", function () {
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

    it("cancels the order without paying a fee (payout disabled)", async function () {
      const data = await networkHelpers.loadFixture(deployUnderwaterWithOrdersFixture);
      const { contracts, accounts } = data;
      const { perps } = contracts;
      const { seller, buyer2, pc } = accounts;

      await data.makeUnderwater();

      const ordersBefore = await perps.read.getUserOrders([seller.account.address]);
      assert.ok(ordersBefore.length >= 1);
      const targetId = ordersBefore[0];

      const liqBalanceBefore = await perps.read.balanceOf([buyer2.account.address]);
      const sellerBalanceBefore = await perps.read.balanceOf([seller.account.address]);

      const hash = await perps.write.liquidateOrder([seller.account.address, targetId], {
        account: buyer2.account,
      });
      const receipt = await pc.waitForTransactionReceipt({ hash });

      const liqBalanceAfter = await perps.read.balanceOf([buyer2.account.address]);
      const sellerBalanceAfter = await perps.read.balanceOf([seller.account.address]);

      // Keeper-incentive payout is disabled: no transfer between seller and liquidator.
      assert.equal(liqBalanceAfter - liqBalanceBefore, 0n);
      assert.equal(sellerBalanceBefore - sellerBalanceAfter, 0n);

      const ordersAfter = await perps.read.getUserOrders([seller.account.address]);
      assert.equal(ordersAfter.length, ordersBefore.length - 1);
      assert.ok(!ordersAfter.includes(targetId));

      const events = parseEventLogs({ abi: perps.abi, logs: receipt.logs });
      const cancelled = events.find((e: any) => e.eventName === "OrderCancelled") as any;
      const liquidated = events.find((e: any) => e.eventName === "OrderLiquidated") as any;
      assert.ok(cancelled, "OrderCancelled should be emitted for indexer compatibility");
      assert.equal(cancelled.args.orderId, targetId);
      assert.ok(liquidated);
      assert.equal(liquidated.args.orderId, targetId);
      assert.equal(
        liquidated.args.liquidator.toLowerCase(),
        buyer2.account.address.toLowerCase(),
      );
      assert.equal(liquidated.args.fee, 0n);
    });

    it("does not transfer any fee even when liquidationFee is set high (payout disabled)", async function () {
      const data = await networkHelpers.loadFixture(deployUnderwaterWithOrdersFixture);
      const { contracts, accounts, config } = data;
      const { perps } = contracts;
      const { seller, buyer2, owner } = accounts;

      await data.makeUnderwater();

      // Set fee far above seller's vault balance — irrelevant, payout is disabled.
      const huge = parseUnits("100000", config.tokenDecimals);
      await perps.write.setLiquidationFee([huge], { account: owner.account });

      const sellerBalanceBefore = await perps.read.balanceOf([seller.account.address]);
      const liqBalanceBefore = await perps.read.balanceOf([buyer2.account.address]);

      const orders = await perps.read.getUserOrders([seller.account.address]);
      await perps.write.liquidateOrder([seller.account.address, orders[0]], {
        account: buyer2.account,
      });

      const sellerBalanceAfter = await perps.read.balanceOf([seller.account.address]);
      const liqBalanceAfter = await perps.read.balanceOf([buyer2.account.address]);

      assert.equal(sellerBalanceAfter, sellerBalanceBefore, "seller balance untouched");
      assert.equal(liqBalanceAfter, liqBalanceBefore, "liquidator balance untouched");
    });
  });

  describe("liquidateOrders (keeper-chosen ids, stop-on-failure)", function () {
    it("cancels all specified orders without paying a fee (payout disabled)", async function () {
      const data = await networkHelpers.loadFixture(deployUnderwaterWithOrdersFixture);
      const { contracts, accounts } = data;
      const { perps } = contracts;
      const { seller, buyer2 } = accounts;

      await data.makeUnderwater();

      const ordersBefore = await perps.read.getUserOrders([seller.account.address]);
      assert.equal(ordersBefore.length, 2);

      const liqBalanceBefore = await perps.read.balanceOf([buyer2.account.address]);

      await perps.write.liquidateOrders([seller.account.address, ordersBefore], {
        account: buyer2.account,
      });

      const liqBalanceAfter = await perps.read.balanceOf([buyer2.account.address]);
      const ordersAfter = await perps.read.getUserOrders([seller.account.address]);

      assert.equal(ordersAfter.length, 0);
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
      const { perps, priceOracle } = contracts;
      const { seller, buyer2 } = accounts;

      // Barely underwater so cancelling resting shorts can flip healthy mid-batch.
      const initialPrice = await perps.read.getMarketPrice();
      const tick = data.config.minimumPriceIncrement;
      const bump = initialPrice + tick * 30n;
      await priceOracle.write.setPrice([bump, data.config.oracle.decimals]);

      const underwater = await perps.read.isLiquidatable([seller.account.address]);
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

    it("succeeds after orders are cleared via multicallStopOnFailure(liquidateOrder × N)", async function () {
      const data = await networkHelpers.loadFixture(deployUnderwaterWithOrdersFixture);
      const { contracts, accounts, config } = data;
      const { perps } = contracts;
      const { seller, buyer2 } = accounts;

      await data.makeUnderwater();

      const orders = await perps.read.getUserOrders([seller.account.address]);
      const calls = orders.map((id) => encodeLiquidateOrder(perps.abi, seller.account.address, id));
      await perps.write.multicallStopOnFailure([calls], { account: buyer2.account });

      const liqBalanceBefore = await perps.read.balanceOf([buyer2.account.address]);

      await perps.write.liquidatePosition([seller.account.address, maxUint256], {
        account: buyer2.account,
      });

      const positionAfter = await perps.read.getUserPosition([seller.account.address]);
      assert.equal(positionAfter.netQuantity, 0n);

      const liqBalanceAfter = await perps.read.balanceOf([buyer2.account.address]);
      // Liquidator gets at most liquidationFee on top of any prior fees.
      assert.ok(liqBalanceAfter - liqBalanceBefore <= config.liquidationFee);
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
        (e: any) => e.eventName === "PositionLiquidated",
      ) as any;
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

  describe("nested multicallStopOnFailure (batch) with orders-first invariant", function () {
    it("skips users with open orders — outer multicall succeeds, no PositionLiquidated emitted", async function () {
      const data = await networkHelpers.loadFixture(deployUnderwaterWithOrdersFixture);
      const { contracts, accounts } = data;
      const { perps } = contracts;
      const { seller, buyer2, pc } = accounts;

      await data.makeUnderwater();

      // Seller is underwater AND has open orders -> the inner liquidatePosition reverts
      // OrdersStillOpen, the inner multicall returns cleanly, and the outer multicall
      // succeeds without emitting PositionLiquidated.
      const calls = [encodeInnerLiquidatePosition(perps.abi, seller.account.address)];
      const hash = await perps.write.multicallStopOnFailure([calls], { account: buyer2.account });
      const receipt = await pc.waitForTransactionReceipt({ hash });

      const events = parseEventLogs({ logs: receipt.logs, abi: perps.abi, eventName: "PositionLiquidated" });
      assert.equal(events.length, 0);
    });

    it("liquidates underwater users with no open orders, skips those that have orders", async function () {
      const data = await networkHelpers.loadFixture(deployUnderwaterWithOrdersFixture);
      const { contracts, accounts } = data;
      const { perps } = contracts;
      const { seller, buyer, buyer2 } = accounts;

      await data.makeUnderwater();

      // Force-clear seller's orders via multicallStopOnFailure(liquidateOrder × N) first.
      const sellerOrders = await perps.read.getUserOrders([seller.account.address]);
      const orderCalls = sellerOrders.map((id) =>
        encodeLiquidateOrder(perps.abi, seller.account.address, id),
      );
      await perps.write.multicallStopOnFailure([orderCalls], { account: buyer2.account });

      // Now the nested-multicall batch should succeed for seller even if buyer is still healthy.
      // Explicit gas: `eth_estimateGas` can't size nested-multicall batches correctly (an inner
      // OOG reverts the inner cleanly, which the outer treats as a stop instead of as gas
      // starvation), so we over-allocate. The off-chain keeper (in the collateral-margin
      // repo) implements the production batch gas-sizing strategy.
      const calls = [seller.account.address, buyer.account.address].map((u) =>
        encodeInnerLiquidatePosition(perps.abi, u),
      );
      await perps.write.multicallStopOnFailure([calls], {
        account: buyer2.account,
        gas: 5_000_000n,
      });

      const sellerPos = await perps.read.getUserPosition([seller.account.address]);
      assert.equal(sellerPos.netQuantity, 0n);
    });
  });
});
