import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { encodeFunctionData, getAddress, maxUint256, parseEventLogs } from "viem";
import type { Hex } from "viem";
import {
  deployPerpsWithPositionsFixture,
  deployPerpsWithLiquidatablePositionFixture,
  deployPerpsWithBatchLiquidatableFixture,
} from "./fixtures.ts";

const { viem, networkHelpers } = await network.connect();

/**
 * Encode the per-user "skip-and-continue" cell for the nested-multicall batch
 * pattern: each `liquidatePosition(user)` is wrapped in its own single-entry
 * `multicallStopOnFailure`, so a per-user revert (`NotLiquidatable`,
 * `OrdersStillOpen`, etc.) becomes a successful return of the inner multicall,
 * and the outer multicall continues to the next user.
 *
 * See {MulticallStopOnFailureUpgradeable} for OOG-vs-clean-revert semantics.
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
          // Full close (clamped to |netQty|) — the batch tests exercise complete liquidations.
          args: [user, maxUint256],
        }),
      ],
    ],
  });
}

/**
 * `liquidateBatch(address[])` was retired in favour of having keepers compose
 * `multicallStopOnFailure(multicallStopOnFailure(liquidatePosition))` — see
 * {HashPowerPerpsDEX.liquidatePosition} NatSpec for the full rationale. These
 * tests cover both the single-user path (`liquidatePosition` directly) and the
 * batched path (nested multicall composition).
 */
describe("HashPowerPerpsDEX - liquidatePosition (+ batches via nested multicallStopOnFailure)", function () {
  it("should revert when position is healthy", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithPositionsFixture);
    const { perps } = contracts;
    const { seller, buyer2 } = accounts;

    const isLiquidatable = await perps.read.isLiquidatable([seller.account.address]);
    assert.ok(!isLiquidatable);

    await viem.assertions.revertWithCustomError(
      perps.write.liquidatePosition([seller.account.address, maxUint256], { account: buyer2.account }),
      perps,
      "NotLiquidatable",
    );
  });

  it("should liquidate underwater position successfully", async function () {
    const data = await networkHelpers.loadFixture(deployPerpsWithLiquidatablePositionFixture);
    const { contracts, accounts } = data;
    const { perps } = contracts;
    const { seller, buyer2 } = accounts;

    const positionBefore = await perps.read.getUserPosition([seller.account.address]);
    assert.notEqual(positionBefore.netQuantity, 0n);

    await data.makeLiquidatable();

    const isLiquidatable = await perps.read.isLiquidatable([seller.account.address]);
    assert.ok(isLiquidatable);

    await perps.write.liquidatePosition([seller.account.address, maxUint256], { account: buyer2.account });

    const positionAfter = await perps.read.getUserPosition([seller.account.address]);
    assert.equal(positionAfter.netQuantity, 0n);
  });

  it("should pay liquidator fee", async function () {
    const data = await networkHelpers.loadFixture(deployPerpsWithLiquidatablePositionFixture);
    const { contracts, accounts } = data;
    const { perps } = contracts;
    const { seller, buyer2 } = accounts;

    await data.makeLiquidatable();

    const liquidatorBalanceBefore = await perps.read.balanceOf([buyer2.account.address]);

    await perps.write.liquidatePosition([seller.account.address, maxUint256], { account: buyer2.account });

    const liquidatorBalanceAfter = await perps.read.balanceOf([buyer2.account.address]);

    assert.ok(liquidatorBalanceAfter >= liquidatorBalanceBefore);
  });

  it("should clear position after liquidation", async function () {
    const data = await networkHelpers.loadFixture(deployPerpsWithLiquidatablePositionFixture);
    const { contracts, accounts } = data;
    const { perps } = contracts;
    const { seller, buyer2 } = accounts;

    await data.makeLiquidatable();

    const usersBefore = await perps.read.getUsersWithPositions();
    assert.ok(usersBefore.map((u: string) => getAddress(u)).includes(getAddress(seller.account.address)));

    await perps.write.liquidatePosition([seller.account.address, maxUint256], { account: buyer2.account });

    const usersAfter = await perps.read.getUsersWithPositions();
    assert.ok(!usersAfter.map((u: string) => getAddress(u)).includes(getAddress(seller.account.address)));
  });

  it("should emit PositionLiquidated event", async function () {
    const data = await networkHelpers.loadFixture(deployPerpsWithLiquidatablePositionFixture);
    const { contracts, accounts } = data;
    const { perps } = contracts;
    const { seller, buyer2, pc } = accounts;

    await data.makeLiquidatable();

    const hash = await perps.write.liquidatePosition([seller.account.address, maxUint256], {
      account: buyer2.account,
    });
    const receipt = await pc.waitForTransactionReceipt({ hash });

    const events = parseEventLogs({ logs: receipt.logs, abi: perps.abi, eventName: "PositionLiquidated" });
    assert.equal(events.length, 1);
  });

  it("should revert when trying to liquidate non-existent position", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithPositionsFixture);
    const { perps } = contracts;
    const { buyer2 } = accounts;

    const position = await perps.read.getUserPosition([buyer2.account.address]);
    assert.equal(position.netQuantity, 0n);

    await viem.assertions.revertWithCustomError(
      perps.write.liquidatePosition([buyer2.account.address, maxUint256], { account: buyer2.account }),
      perps,
      "NotLiquidatable",
    );
  });

  // Loose gas limit for nested-multicall writes. We can't rely on
  // `eth_estimateGas` here: the outer multicall returns successfully even if
  // an inner sub-call OOGs (the inner reverts with a non-empty
  // `MulticallSubCallOutOfGas` selector, which the outer treats as a normal
  // stop). The estimator therefore picks a G that lets the outer return
  // while only the first user actually liquidates. The off-chain keeper (in the
  // collateral-margin repo) sidesteps this by passing
  // `sum(perUserEstimate) * 1.2 + per-user overhead`; these tests just over-allocate.
  const BATCH_GAS = 5_000_000n;

  describe("batches via nested multicallStopOnFailure", function () {
    it("should liquidate multiple underwater positions in a single tx", async function () {
      const data = await networkHelpers.loadFixture(deployPerpsWithBatchLiquidatableFixture);
      const { contracts, accounts } = data;
      const { perps } = contracts;
      const { seller, seller2, buyer2, pc } = accounts;

      await data.makeLiquidatable();

      assert.ok(await perps.read.isLiquidatable([seller.account.address]));
      assert.ok(await perps.read.isLiquidatable([seller2.account.address]));

      const calls = [seller.account.address, seller2.account.address].map((u) =>
        encodeInnerLiquidatePosition(perps.abi, u),
      );
      // Explicit gas: see BATCH_GAS comment above the describe block.
      const hash = await perps.write.multicallStopOnFailure([calls], {
        account: buyer2.account,
        gas: BATCH_GAS,
      });
      const receipt = await pc.waitForTransactionReceipt({ hash });

      const events = parseEventLogs({ logs: receipt.logs, abi: perps.abi, eventName: "PositionLiquidated" });
      assert.equal(events.length, 2);

      const pos1 = await perps.read.getUserPosition([seller.account.address]);
      const pos2 = await perps.read.getUserPosition([seller2.account.address]);
      assert.equal(pos1.netQuantity, 0n);
      assert.equal(pos2.netQuantity, 0n);
    });

    it("should skip non-liquidatable users and still liquidate the rest", async function () {
      const data = await networkHelpers.loadFixture(deployPerpsWithBatchLiquidatableFixture);
      const { contracts, accounts } = data;
      const { perps } = contracts;
      const { seller, seller2, buyer, buyer2, pc } = accounts;

      await data.makeLiquidatable();

      // buyer is long and profiting from the price increase — not liquidatable.
      assert.ok(!(await perps.read.isLiquidatable([buyer.account.address])));
      assert.ok(await perps.read.isLiquidatable([seller.account.address]));

      // Nesting the inner multicall around `liquidatePosition(buyer)` converts
      // its `NotLiquidatable` revert into a successful return, so the outer
      // multicall continues on to liquidate seller2.
      const calls = [seller.account.address, buyer.account.address, seller2.account.address].map(
        (u) => encodeInnerLiquidatePosition(perps.abi, u),
      );
      const hash = await perps.write.multicallStopOnFailure([calls], {
        account: buyer2.account,
        gas: BATCH_GAS,
      });
      const receipt = await pc.waitForTransactionReceipt({ hash });

      const events = parseEventLogs({ logs: receipt.logs, abi: perps.abi, eventName: "PositionLiquidated" });
      assert.equal(events.length, 2, "only the two liquidatable users should be liquidated");

      const posSeller = await perps.read.getUserPosition([seller.account.address]);
      const posBuyer = await perps.read.getUserPosition([buyer.account.address]);
      assert.equal(posSeller.netQuantity, 0n);
      assert.ok(posBuyer.netQuantity !== 0n, "healthy position should be untouched");
    });

    it("does not emit PositionLiquidated when no user is liquidatable", async function () {
      // Replaces the legacy "should revert if no users are liquidatable" test:
      // skip-and-continue semantics by definition do NOT revert when every
      // sub-call fails — the outer multicall returns `successes = [false, …]`
      // and zero `PositionLiquidated` events are emitted.
      const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithPositionsFixture);
      const { perps } = contracts;
      const { seller, buyer, buyer2, pc } = accounts;

      const calls = [seller.account.address, buyer.account.address].map((u) =>
        encodeInnerLiquidatePosition(perps.abi, u),
      );
      const { result: outerResult } = await perps.simulate.multicallStopOnFailure([calls], {
        account: buyer2.account.address,
        gas: BATCH_GAS,
      });
      // Outer succeeded for every entry (each inner returned cleanly with successes=[false]).
      const [successes] = outerResult;
      assert.deepEqual(successes, [true, true]);

      const hash = await perps.write.multicallStopOnFailure([calls], {
        account: buyer2.account,
        gas: BATCH_GAS,
      });
      const receipt = await pc.waitForTransactionReceipt({ hash });
      const events = parseEventLogs({ logs: receipt.logs, abi: perps.abi, eventName: "PositionLiquidated" });
      assert.equal(events.length, 0);
    });

    it("should emit PositionLiquidated with fee for each user", async function () {
      const data = await networkHelpers.loadFixture(deployPerpsWithBatchLiquidatableFixture);
      const { contracts, accounts } = data;
      const { perps } = contracts;
      const { seller, seller2, buyer2, pc } = accounts;

      await data.makeLiquidatable();

      const calls = [seller.account.address, seller2.account.address].map((u) =>
        encodeInnerLiquidatePosition(perps.abi, u),
      );
      const hash = await perps.write.multicallStopOnFailure([calls], {
        account: buyer2.account,
        gas: BATCH_GAS,
      });
      const receipt = await pc.waitForTransactionReceipt({ hash });

      const events = parseEventLogs({ logs: receipt.logs, abi: perps.abi, eventName: "PositionLiquidated" });
      assert.equal(events.length, 2);

      const liquidators = events.map((e) => getAddress(e.args.liquidator));
      assert.ok(liquidators.every((l) => l === getAddress(buyer2.account.address)));
    });

    it("single-element batch is equivalent to direct liquidatePosition", async function () {
      const data = await networkHelpers.loadFixture(deployPerpsWithBatchLiquidatableFixture);
      const { contracts, accounts } = data;
      const { perps } = contracts;
      const { seller, buyer2 } = accounts;

      await data.makeLiquidatable();

      const calls = [encodeInnerLiquidatePosition(perps.abi, seller.account.address)];
      await perps.write.multicallStopOnFailure([calls], {
        account: buyer2.account,
        gas: BATCH_GAS,
      });

      const pos = await perps.read.getUserPosition([seller.account.address]);
      assert.equal(pos.netQuantity, 0n);
    });
  });
});
