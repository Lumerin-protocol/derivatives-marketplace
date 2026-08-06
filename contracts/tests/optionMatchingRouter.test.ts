import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { deployMatchingRouterFixture, defaultSeries } from "./optionsFixtures.ts";
import { writeContract } from "viem/actions";

const { viem, networkHelpers } = await network.connect();

const TICK_SIZE_E8 = defaultSeries.tickSizeE8; // 1_000_000n = $0.01
const LOT = BigInt(defaultSeries.lotSize); // 1_000_000

// OrderType enum values
const LIMIT = 0;
const IOC = 1;
const FOK = 2;

function premiumWad(ticks: bigint, size: bigint): bigint {
  return (ticks * BigInt(TICK_SIZE_E8) * 10n ** 10n * size) / LOT;
}

describe("OptionMatchingRouter", () => {
  // ── Basic order placement ───────────────────────────────────────────────

  describe("resting orders", () => {
    it("buy limit rests on book when no opposing orders", async () => {
      const { router, book, traders, seriesId } = await networkHelpers.loadFixture(
        deployMatchingRouterFixture,
      );
      const { trader1 } = traders;

      const sim = await router.simulate.submitOrder(
        [
          {
            seriesId,
            isBuy: true,
            priceTicks: 100n,
            size: LOT,
            orderType: LIMIT,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: trader1.account.address },
      );
      await writeContract(trader1, sim.request);

      assert.ok(sim.result.orderId > 0n, "order should rest");
      assert.equal(sim.result.filledSize, 0n);
      assert.equal(sim.result.restedSize, LOT);

      const [, bestBidTick] = await book.read.bestBid([seriesId]);
      assert.equal(bestBidTick, 100n);
    });

    it("sell limit rests on book and reserves IM", async () => {
      const { router, engine, traders, seriesId } = await networkHelpers.loadFixture(
        deployMatchingRouterFixture,
      );
      const { trader1 } = traders;

      await router.write.submitOrder(
        [
          {
            seriesId,
            isBuy: false,
            priceTicks: 200n,
            size: LOT,
            orderType: LIMIT,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: trader1.account },
      );

      const reserved = await engine.read.getReservedMargin([trader1.account.address]);
      assert.ok(reserved > 0n, "IM should be reserved for resting sell");
    });
  });

  // ── Matching ──────────────────────────────────────────────────────────

  describe("matching", () => {
    it("buy crosses resting ask — full fill", async () => {
      const { router, engine, traders, seriesId } = await networkHelpers.loadFixture(
        deployMatchingRouterFixture,
      );
      const { trader1, trader2 } = traders;

      // Trader2 places a sell at tick 150
      await router.write.submitOrder(
        [
          {
            seriesId,
            isBuy: false,
            priceTicks: 150n,
            size: LOT,
            orderType: LIMIT,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: trader2.account },
      );

      const buyer1BalBefore = await engine.read.getCollateral([trader1.account.address]);

      // Trader1 places a buy at tick 150 — should match
      const sim = await router.simulate.submitOrder(
        [
          {
            seriesId,
            isBuy: true,
            priceTicks: 150n,
            size: LOT,
            orderType: LIMIT,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: trader1.account.address },
      );
      await writeContract(trader1, sim.request);

      assert.equal(sim.result.filledSize, LOT, "should be fully filled");
      assert.equal(sim.result.restedSize, 0n, "nothing should rest");
      assert.equal(sim.result.orderId, 0n, "no resting order ID");

      // Positions are stored in raw units (fillSize = LOT)
      const buyerPos = await engine.read.getPosition([trader1.account.address, seriesId]);
      const sellerPos = await engine.read.getPosition([trader2.account.address, seriesId]);
      assert.equal(buyerPos, LOT);
      assert.equal(sellerPos, -LOT);

      // Check premium transfer
      const expectedPremium = premiumWad(150n, LOT);
      const buyer1BalAfter = await engine.read.getCollateral([trader1.account.address]);
      assert.equal(buyer1BalBefore - buyer1BalAfter, expectedPremium);
    });

    it("sell crosses resting bid — full fill", async () => {
      const { router, engine, traders, seriesId } = await networkHelpers.loadFixture(
        deployMatchingRouterFixture,
      );
      const { trader1, trader2 } = traders;

      // Trader1 bids at tick 100
      await router.write.submitOrder(
        [
          {
            seriesId,
            isBuy: true,
            priceTicks: 100n,
            size: LOT,
            orderType: LIMIT,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: trader1.account },
      );

      // Trader2 sells at tick 100 — matches
      await router.write.submitOrder(
        [
          {
            seriesId,
            isBuy: false,
            priceTicks: 100n,
            size: LOT,
            orderType: LIMIT,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: trader2.account },
      );

      const buyerPos = await engine.read.getPosition([trader1.account.address, seriesId]);
      const sellerPos = await engine.read.getPosition([trader2.account.address, seriesId]);
      assert.equal(buyerPos, BigInt(defaultSeries.lotSize));
      assert.equal(sellerPos, -BigInt(defaultSeries.lotSize));
    });

    it("partial fill — remainder rests on book", async () => {
      const { router, book, traders, seriesId } = await networkHelpers.loadFixture(
        deployMatchingRouterFixture,
      );
      const { trader1, trader2 } = traders;

      // Trader2 asks 2 lots at tick 120
      await router.write.submitOrder(
        [
          {
            seriesId,
            isBuy: false,
            priceTicks: 120n,
            size: LOT * 2n,
            orderType: LIMIT,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: trader2.account },
      );

      // Trader1 bids 5 lots at tick 120 — fills 2, rests 3
      const sim = await router.simulate.submitOrder(
        [
          {
            seriesId,
            isBuy: true,
            priceTicks: 120n,
            size: LOT * 5n,
            orderType: LIMIT,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: trader1.account.address },
      );
      await writeContract(trader1, sim.request);

      assert.equal(sim.result.filledSize, LOT * 2n);
      assert.equal(sim.result.restedSize, LOT * 3n);
      assert.ok(sim.result.orderId > 0n);

      // Book should have the resting bid
      const [, bestBidTick] = await book.read.bestBid([seriesId]);
      assert.equal(bestBidTick, 120n);
    });

    it("multi-level walk: buy fills across multiple ask levels", async () => {
      const { router, engine, traders, seriesId } = await networkHelpers.loadFixture(
        deployMatchingRouterFixture,
      );
      const { trader1, trader2 } = traders;

      // Trader2 places asks at 100, 110, 120 (1 lot each)
      for (const tick of [100n, 110n, 120n]) {
        await router.write.submitOrder(
          [
            {
              seriesId,
              isBuy: false,
              priceTicks: tick,
              size: LOT,
              orderType: LIMIT,
              postOnly: false,
              reduceOnly: false,
            },
          ],
          { account: trader2.account },
        );
      }

      // Trader1 bids 3 lots at tick 120 — should fill all three levels
      const sim = await router.simulate.submitOrder(
        [
          {
            seriesId,
            isBuy: true,
            priceTicks: 120n,
            size: LOT * 3n,
            orderType: LIMIT,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: trader1.account.address },
      );
      await writeContract(trader1, sim.request);

      assert.equal(sim.result.filledSize, LOT * 3n);
      assert.equal(sim.result.restedSize, 0n);

      // Positions: buyer has +3 contracts, seller has -3 contracts
      const buyerPos = await engine.read.getPosition([trader1.account.address, seriesId]);
      assert.equal(buyerPos, BigInt(defaultSeries.lotSize) * 3n);
    });

    it("premium transfers at maker's price (price improvement)", async () => {
      const { router, engine, traders, seriesId } = await networkHelpers.loadFixture(
        deployMatchingRouterFixture,
      );
      const { trader1, trader2 } = traders;

      // Ask at tick 80
      await router.write.submitOrder(
        [
          {
            seriesId,
            isBuy: false,
            priceTicks: 80n,
            size: LOT,
            orderType: LIMIT,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: trader2.account },
      );

      const buyerBefore = await engine.read.getCollateral([trader1.account.address]);

      // Buy at tick 100 — fills at maker's 80 (price improvement for buyer)
      await router.write.submitOrder(
        [
          {
            seriesId,
            isBuy: true,
            priceTicks: 100n,
            size: LOT,
            orderType: LIMIT,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: trader1.account },
      );

      const buyerAfter = await engine.read.getCollateral([trader1.account.address]);
      const paidPremium = buyerBefore - buyerAfter;
      const expectedAtMaker = premiumWad(80n, LOT);

      assert.equal(paidPremium, expectedAtMaker, "should fill at maker's price");
    });
  });

  // ── Order types ───────────────────────────────────────────────────────

  describe("order types", () => {
    it("IOC fills what it can, discards remainder", async () => {
      const { router, traders, seriesId } = await networkHelpers.loadFixture(
        deployMatchingRouterFixture,
      );
      const { trader1, trader2 } = traders;

      // 1 lot resting ask at 100
      await router.write.submitOrder(
        [
          {
            seriesId,
            isBuy: false,
            priceTicks: 100n,
            size: LOT,
            orderType: LIMIT,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: trader2.account },
      );

      // IOC buy 3 lots — fills 1, discards 2
      const sim = await router.simulate.submitOrder(
        [
          {
            seriesId,
            isBuy: true,
            priceTicks: 100n,
            size: LOT * 3n,
            orderType: IOC,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: trader1.account.address },
      );
      await writeContract(trader1, sim.request);

      assert.equal(sim.result.filledSize, LOT);
      assert.equal(sim.result.restedSize, 0n, "IOC should not rest");
      assert.equal(sim.result.orderId, 0n);
    });

    it("FOK reverts if not fully fillable", async () => {
      const { router, traders, seriesId } = await networkHelpers.loadFixture(
        deployMatchingRouterFixture,
      );
      const { trader1, trader2 } = traders;

      // 1 lot resting ask
      await router.write.submitOrder(
        [
          {
            seriesId,
            isBuy: false,
            priceTicks: 100n,
            size: LOT,
            orderType: LIMIT,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: trader2.account },
      );

      // FOK buy 3 lots — only 1 available → revert
      await viem.assertions.revertWithCustomError(
        router.write.submitOrder(
          [
            {
              seriesId,
              isBuy: true,
              priceTicks: 100n,
              size: LOT * 3n,
              orderType: FOK,
              postOnly: false,
              reduceOnly: false,
            },
          ],
          { account: trader1.account },
        ),
        router,
        "FOKNotFillable",
      );
    });

    it("FOK succeeds when fully fillable", async () => {
      const { router, traders, seriesId } = await networkHelpers.loadFixture(
        deployMatchingRouterFixture,
      );
      const { trader1, trader2 } = traders;
      // 3 lots resting ask
      await router.write.submitOrder(
        [
          {
            seriesId,
            isBuy: false,
            priceTicks: 100n,
            size: LOT * 3n,
            orderType: LIMIT,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: trader2.account },
      );

      // FOK buy 3 lots — exactly fillable
      const sim = await router.simulate.submitOrder(
        [
          {
            seriesId,
            isBuy: true,
            priceTicks: 100n,
            size: LOT * 3n,
            orderType: FOK,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: trader1.account.address },
      );
      await writeContract(trader1, sim.request);

      assert.equal(sim.result.filledSize, LOT * 3n);
    });

    it("postOnly rests without matching", async () => {
      const { router, book, traders, seriesId } = await networkHelpers.loadFixture(
        deployMatchingRouterFixture,
      );
      const { trader1 } = traders;

      // postOnly buy at tick 50 (no asks, so it rests)
      await router.write.submitOrder(
        [
          {
            seriesId,
            isBuy: true,
            priceTicks: 50n,
            size: LOT,
            orderType: LIMIT,
            postOnly: true,
            reduceOnly: false,
          },
        ],
        { account: trader1.account },
      );

      const [, bestBidTick] = await book.read.bestBid([seriesId]);
      assert.equal(bestBidTick, 50n);
    });

    it("postOnly reverts if would cross", async () => {
      const { router, traders, seriesId } = await networkHelpers.loadFixture(
        deployMatchingRouterFixture,
      );
      const { trader1, trader2 } = traders;

      // Ask at 100
      await router.write.submitOrder(
        [
          {
            seriesId,
            isBuy: false,
            priceTicks: 100n,
            size: LOT,
            orderType: LIMIT,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: trader2.account },
      );

      // postOnly buy at 100 → would cross → revert
      await viem.assertions.revertWithCustomError(
        router.write.submitOrder(
          [
            {
              seriesId,
              isBuy: true,
              priceTicks: 100n,
              size: LOT,
              orderType: LIMIT,
              postOnly: true,
              reduceOnly: false,
            },
          ],
          { account: trader1.account },
        ),
        router,
        "PostOnlyWouldMatch",
      );
    });
  });

  // ── Cancel ────────────────────────────────────────────────────────────

  describe("cancelOrder", () => {
    it("owner cancels resting buy order", async () => {
      const { router, book, traders, seriesId } = await networkHelpers.loadFixture(
        deployMatchingRouterFixture,
      );
      const { trader1 } = traders;

      const sim = await router.simulate.submitOrder(
        [
          {
            seriesId,
            isBuy: true,
            priceTicks: 80n,
            size: LOT,
            orderType: LIMIT,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: trader1.account.address },
      );
      await writeContract(trader1, sim.request);
      const orderId = sim.result.orderId;

      await router.write.cancelOrder([orderId], { account: trader1.account });

      const isActive = await book.read.isOrderActive([orderId]);
      assert.ok(!isActive, "order should be cancelled");
    });

    it("cancel sell releases reserved IM", async () => {
      const { router, engine, traders, seriesId } = await networkHelpers.loadFixture(
        deployMatchingRouterFixture,
      );
      const { trader1 } = traders;

      const sim = await router.simulate.submitOrder(
        [
          {
            seriesId,
            isBuy: false,
            priceTicks: 200n,
            size: LOT,
            orderType: LIMIT,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: trader1.account.address },
      );
      await writeContract(trader1, sim.request);
      const orderId = sim.result.orderId;

      const reservedBefore = await engine.read.getReservedMargin([trader1.account.address]);
      assert.ok(reservedBefore > 0n);

      await router.write.cancelOrder([orderId], { account: trader1.account });

      const reservedAfter = await engine.read.getReservedMargin([trader1.account.address]);
      assert.equal(reservedAfter, 0n, "reserved margin should be fully released");
    });

    it("non-owner cannot cancel", async () => {
      const { router, traders, seriesId } = await networkHelpers.loadFixture(
        deployMatchingRouterFixture,
      );
      const { trader1, trader2 } = traders;

      const sim = await router.simulate.submitOrder(
        [
          {
            seriesId,
            isBuy: true,
            priceTicks: 80n,
            size: LOT,
            orderType: LIMIT,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: trader1.account.address },
      );
      await writeContract(trader1, sim.request);

      await viem.assertions.revertWithCustomError(
        router.write.cancelOrder([sim.result.orderId], { account: trader2.account }),
        router,
        "NotOrderOwner",
      );
    });
  });

  // ── Margin integration ────────────────────────────────────────────────

  describe("margin integration", () => {
    it("sell order reverts if insufficient collateral", async () => {
      const { router, engine, vault, traders, seriesId } = await networkHelpers.loadFixture(
        deployMatchingRouterFixture,
      );
      const { trader1 } = traders;

      // Withdraw most collateral
      const bal = await engine.read.getCollateral([trader1.account.address]);
      const wadUnit = 10n ** 12n;
      const withdrawUsdc = bal / wadUnit - 1n; // leave $1
      await vault.write.withdraw([withdrawUsdc], { account: trader1.account });

      await viem.assertions.revertWithCustomError(
        router.write.submitOrder(
          [
            {
              seriesId,
              isBuy: false,
              priceTicks: 100n,
              size: LOT * 100n,
              orderType: LIMIT,
              postOnly: false,
              reduceOnly: false,
            },
          ],
          { account: trader1.account },
        ),
        router,
        "InsufficientMargin",
      );
    });

    it("buy that exceeds collateral for premium reverts", async () => {
      const { router, engine, vault, traders, seriesId } = await networkHelpers.loadFixture(
        deployMatchingRouterFixture,
      );
      const { trader1, trader2 } = traders;

      // Trader2 sells 1 lot at tick 500 (premium = 500 * 0.01 = $5)
      await router.write.submitOrder(
        [
          {
            seriesId,
            isBuy: false,
            priceTicks: 500n,
            size: LOT,
            orderType: LIMIT,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: trader2.account },
      );

      // Withdraw trader1's collateral, leaving less than $5 premium
      const bal = await engine.read.getCollateral([trader1.account.address]);
      const wadUnit = 10n ** 12n;
      const leaveUsdc = 1n; // leave $0.000001 (1 unit of USDC)
      const withdrawUsdc = bal / wadUnit - leaveUsdc;
      await vault.write.withdraw([withdrawUsdc], { account: trader1.account });

      // Buy 1 lot at tick 500 — premium $5 but only ~$0 collateral
      await viem.assertions.revertWithCustomError(
        router.write.submitOrder(
          [
            {
              seriesId,
              isBuy: true,
              priceTicks: 500n,
              size: LOT,
              orderType: LIMIT,
              postOnly: false,
              reduceOnly: false,
            },
          ],
          { account: trader1.account },
        ),
        engine,
        "InsufficientCollateral",
      );
    });

    it("fill releases maker's reserved IM proportionally", async () => {
      const { router, engine, traders, seriesId } = await networkHelpers.loadFixture(
        deployMatchingRouterFixture,
      );
      const { trader1, trader2 } = traders;

      // Trader2 sells 4 lots at tick 100
      const sim = await router.simulate.submitOrder(
        [
          {
            seriesId,
            isBuy: false,
            priceTicks: 100n,
            size: LOT * 4n,
            orderType: LIMIT,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: trader2.account.address },
      );
      await writeContract(trader2, sim.request);

      const reservedFull = await engine.read.getReservedMargin([trader2.account.address]);
      assert.ok(reservedFull > 0n);

      // Trader1 buys 1 lot — partially fills maker's 4-lot order
      await router.write.submitOrder(
        [
          {
            seriesId,
            isBuy: true,
            priceTicks: 100n,
            size: LOT,
            orderType: LIMIT,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: trader1.account },
      );

      const reservedAfterPartial = await engine.read.getReservedMargin([trader2.account.address]);
      // Should have released ~25% of reserved
      const released = reservedFull - reservedAfterPartial;
      const expectedRelease = reservedFull / 4n;
      assert.ok(
        released >= expectedRelease - 1n && released <= expectedRelease + 1n,
        `expected ~${expectedRelease}, got ${released}`,
      );
    });
  });

  // ── ReduceOnly ────────────────────────────────────────────────────────

  describe("reduceOnly", () => {
    it("reduceOnly buy caps at short position size", async () => {
      const { router, engine, traders, seriesId } = await networkHelpers.loadFixture(
        deployMatchingRouterFixture,
      );
      const { trader1, trader2 } = traders;

      // Give trader1 a short position of -2 via direct engine update (owner is no longer router, so we need the router)
      // Instead: have trader1 sell 2 lots against trader2's bid
      await router.write.submitOrder(
        [
          {
            seriesId,
            isBuy: true,
            priceTicks: 100n,
            size: LOT * 2n,
            orderType: LIMIT,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: trader2.account },
      );
      await router.write.submitOrder(
        [
          {
            seriesId,
            isBuy: false,
            priceTicks: 100n,
            size: LOT * 2n,
            orderType: LIMIT,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: trader1.account },
      );

      // Trader1 is now short 2 lots
      const posBefore = await engine.read.getPosition([trader1.account.address, seriesId]);
      assert.equal(posBefore, -(BigInt(defaultSeries.lotSize) * 2n));

      // Place ask so trader1 can buy to reduce
      await router.write.submitOrder(
        [
          {
            seriesId,
            isBuy: false,
            priceTicks: 100n,
            size: LOT * 5n,
            orderType: LIMIT,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: trader2.account },
      );

      // ReduceOnly buy 5 lots — capped at 2 (abs position)
      const sim = await router.simulate.submitOrder(
        [
          {
            seriesId,
            isBuy: true,
            priceTicks: 100n,
            size: LOT * 5n,
            orderType: LIMIT,
            postOnly: false,
            reduceOnly: true,
          },
        ],
        { account: trader1.account.address },
      );
      await writeContract(trader1, sim.request);

      assert.equal(sim.result.filledSize, LOT * 2n, "capped at 2 lots");
      const posAfter = await engine.read.getPosition([trader1.account.address, seriesId]);
      assert.equal(posAfter, 0n, "position closed");
    });

    it("reduceOnly reverts with no opposing position", async () => {
      const { router, traders, seriesId } = await networkHelpers.loadFixture(
        deployMatchingRouterFixture,
      );
      const { trader1 } = traders;

      // Trader1 has no position — reduceOnly buy should revert
      await viem.assertions.revertWithCustomError(
        router.write.submitOrder(
          [
            {
              seriesId,
              isBuy: true,
              priceTicks: 100n,
              size: LOT,
              orderType: LIMIT,
              postOnly: false,
              reduceOnly: true,
            },
          ],
          { account: trader1.account },
        ),
        router,
        "ReduceOnlyNoPosition",
      );
    });
  });

  // ── IV update on fill ─────────────────────────────────────────────────

  describe("IV update", () => {
    it("IV updates after a fill", async () => {
      const { router, engine, traders, seriesId } = await networkHelpers.loadFixture(
        deployMatchingRouterFixture,
      );
      const { trader1, trader2 } = traders;

      // Initialize IV
      await engine.write.initializeIV([seriesId]);
      const [ivBefore] = await engine.read.getIVState([seriesId]);

      // Trader2 asks 1 lot at tick 100
      await router.write.submitOrder(
        [
          {
            seriesId,
            isBuy: false,
            priceTicks: 100n,
            size: LOT,
            orderType: LIMIT,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: trader2.account },
      );

      // Trader1 buys 1 lot — triggers IV update
      await router.write.submitOrder(
        [
          {
            seriesId,
            isBuy: true,
            priceTicks: 100n,
            size: LOT,
            orderType: LIMIT,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: trader1.account },
      );

      const [ivAfter] = await engine.read.getIVState([seriesId]);
      assert.notEqual(ivAfter, ivBefore, "IV should have changed after trade");
    });
  });

  // ── Validation ────────────────────────────────────────────────────────

  describe("validation", () => {
    it("rejects zero price", async () => {
      const { router, traders, seriesId } = await networkHelpers.loadFixture(
        deployMatchingRouterFixture,
      );
      const { trader1 } = traders;

      await viem.assertions.revertWithCustomError(
        router.write.submitOrder(
          [
            {
              seriesId,
              isBuy: true,
              priceTicks: 0n,
              size: LOT,
              orderType: LIMIT,
              postOnly: false,
              reduceOnly: false,
            },
          ],
          { account: trader1.account },
        ),
        router,
        "InvalidPrice",
      );
    });

    it("rejects size not on lot boundary", async () => {
      const { router, traders, seriesId } = await networkHelpers.loadFixture(
        deployMatchingRouterFixture,
      );
      const { trader1 } = traders;

      await viem.assertions.revertWithCustomError(
        router.write.submitOrder(
          [
            {
              seriesId,
              isBuy: true,
              priceTicks: 100n,
              size: LOT + 1n,
              orderType: LIMIT,
              postOnly: false,
              reduceOnly: false,
            },
          ],
          { account: trader1.account },
        ),
        router,
        "SizeNotOnLot",
      );
    });

    it("rejects postOnly with IOC", async () => {
      const { router, traders, seriesId } = await networkHelpers.loadFixture(
        deployMatchingRouterFixture,
      );
      const { trader1 } = traders;

      await viem.assertions.revertWithCustomError(
        router.write.submitOrder(
          [
            {
              seriesId,
              isBuy: true,
              priceTicks: 100n,
              size: LOT,
              orderType: IOC,
              postOnly: true,
              reduceOnly: false,
            },
          ],
          { account: trader1.account },
        ),
        router,
        "InvalidParams",
      );
    });
  });
});
