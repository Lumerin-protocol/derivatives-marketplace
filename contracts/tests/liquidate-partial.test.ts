import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { maxUint256, parseEventLogs, parseUnits } from "viem";
import type { NetworkConnection } from "hardhat/types/network";
import { deployPerpsFixture } from "./fixtures.ts";
import { TimeInForce } from "../fixtures/timeInForce.ts";

const { viem, networkHelpers } = await network.connect();

/**
 * `liquidatePosition(user, closeQty)` — partial close down to the IM buffer.
 *
 * `closeQty` is an upper bound: the contract closes up to `min(closeQty, |netQty|)`.
 * The keeper sizes the partial off-chain; with a position remaining and a real
 * IM buffer (`im > mm`), leftover balance above IM reverts `OverLiquidation`.
 * A full close (closeQty ≥ |netQty|) deletes the position (bad-debt path) and
 * skips that guard.
 *
 * Fixture: seller is short 40 @ $4.21 (PME default 10% IM / 5% MM → real
 * buffer), deposit ≈ 13·entry. A +30% pump breaks MM while leaving a
 * recoverable band; closing ~25–32 qty lands `[MM, IM]`, closing ~38 overshoots
 * IM, a +200% pump plus a full close is the bad-debt path.
 */
async function partialPerpsFixture(_conn: NetworkConnection) {
  const data = await networkHelpers.loadFixture(deployPerpsFixture);
  const { contracts, accounts, config } = data;
  const { perps, priceOracle, vault } = contracts;
  const { seller, buyer, owner } = accounts;

  // Zero the liquidation fee so the deposit/band math is purely margin-driven.
  await perps.write.setLiquidationFeeBps([0], { account: owner.account });

  const entry = await perps.read.getMarketPrice();
  const qty = parseUnits("40", config.quantityDecimals);

  // Seller short 40. deposit ≈ 13·entry (13 · $42.10 ≈ $547): clears entry IM
  // (40 · 0.10 · entry = 4·entry) but a +30% pump drives MM > deposit. The deposit
  // ratios are scale-invariant; the buyer only needs to over-collateralize its long
  // while staying within its wallet balance (20·entry ≈ $842 < the 1000 top-up).
  const sellerDeposit = entry * 13n;
  const buyerDeposit = entry * 20n;
  await vault.write.deposit([sellerDeposit], { account: seller.account });
  await vault.write.deposit([buyerDeposit], { account: buyer.account });

  // seller shorts, buyer takes the long.
  await perps.write.createOrder([entry, -qty, TimeInForce.GTC], { account: seller.account });
  await perps.write.createOrder([entry, qty, TimeInForce.GTC], { account: buyer.account });

  return {
    ...data,
    config: { ...config, entry, qty },
    /** Move the mark to `factorNum/factorDen · entry` (a pump for the short). */
    async pump(factorNum: bigint, factorDen: bigint) {
      // Oracle quotes 1 PH/s/day (= contract unit), so write the mark directly.
      const newMark = (entry * factorNum) / factorDen;
      await priceOracle.write.setPrice([newMark, config.oracle.decimals]);
      return newMark;
    },
  };
}

describe("HashPowerPerpsDEX - liquidatePosition(user, closeQty) partial close", function () {
  it("reverts NotLiquidatable when the user is healthy (MM trigger)", async function () {
    const data = await networkHelpers.loadFixture(partialPerpsFixture);
    const { contracts, accounts, config } = data;
    const { perps } = contracts;
    const { seller, buyer2 } = accounts;

    assert.ok(!(await perps.read.isLiquidatable([seller.account.address])));

    await viem.assertions.revertWithCustomError(
      perps.write.liquidatePosition([seller.account.address, config.qty], {
        account: buyer2.account,
      }),
      perps,
      "NotLiquidatable",
    );
  });

  it("reverts OrdersStillOpen when the user has a resting order", async function () {
    const data = await networkHelpers.loadFixture(partialPerpsFixture);
    const { contracts, accounts, config } = data;
    const { perps } = contracts;
    const { seller, buyer2 } = accounts;

    // A far-out-of-market resting sell that never matches, held by seller.
    await perps.write.createOrder([config.entry * 3n, -parseUnits("1", config.quantityDecimals), TimeInForce.GTC], {
      account: seller.account,
    });

    await data.pump(13n, 10n);

    await viem.assertions.revertWithCustomError(
      perps.write.liquidatePosition([seller.account.address, config.qty], {
        account: buyer2.account,
      }),
      perps,
      "OrdersStillOpen",
    );
  });

  it("partially closes into the [MM, IM] band and leaves the residual short open", async function () {
    const data = await networkHelpers.loadFixture(partialPerpsFixture);
    const { contracts, accounts, config } = data;
    const { perps, vault, pme } = contracts;
    const { seller, buyer2 } = accounts;

    await data.pump(13n, 10n); // +30%
    assert.ok(await perps.read.isLiquidatable([seller.account.address]));

    const closeQty = parseUnits("30", config.quantityDecimals);
    await perps.write.liquidatePosition([seller.account.address, closeQty], {
      account: buyer2.account,
    });

    // Residual short remains (not fully closed).
    const pos = await perps.read.getUserPosition([seller.account.address]);
    assert.equal(pos.netQuantity, -(config.qty - closeQty), "expected netQty reduced by closeQty");
    assert.ok(pos.netQuantity < 0n, "residual short should still be open");

    // Landed in the [MM, IM] band.
    const [balance, im, mm] = await Promise.all([
      vault.read.balanceOf([seller.account.address]),
      pme.read.computePortfolioIM([seller.account.address]),
      pme.read.computePortfolioMM([seller.account.address]),
    ]);
    assert.ok(balance >= mm, `expected balance >= MM, got balance=${balance} mm=${mm}`);
    assert.ok(balance <= im, `expected balance <= IM, got balance=${balance} im=${im}`);
  });

  it("clamps closeQty to |netQty| and fully closes when asked to close everything", async function () {
    const data = await networkHelpers.loadFixture(partialPerpsFixture);
    const { contracts, accounts } = data;
    const { perps } = contracts;
    const { seller, buyer2 } = accounts;

    await data.pump(13n, 10n);

    // closeQty far exceeds |netQty| → clamps to a full close.
    await perps.write.liquidatePosition([seller.account.address, maxUint256], {
      account: buyer2.account,
    });

    const pos = await perps.read.getUserPosition([seller.account.address]);
    assert.equal(pos.netQuantity, 0n, "position should be fully closed");
  });

  it("reverts OverLiquidation when an oversize partial leaves balance above IM", async function () {
    const data = await networkHelpers.loadFixture(partialPerpsFixture);
    const { contracts, accounts, config } = data;
    const { perps } = contracts;
    const { seller, buyer2 } = accounts;

    await data.pump(13n, 10n);

    // Closing 38 of 40 leaves a 2-qty short whose IM is tiny vs residual balance.
    const tooMuch = parseUnits("38", config.quantityDecimals);
    await viem.assertions.revertWithCustomError(
      perps.write.liquidatePosition([seller.account.address, tooMuch], {
        account: buyer2.account,
      }),
      perps,
      "OverLiquidation",
    );
  });

  it("full close on a deep move skips the over-liquidation guard (bad-debt path)", async function () {
    const data = await networkHelpers.loadFixture(partialPerpsFixture);
    const { contracts, accounts } = data;
    const { perps } = contracts;
    const { seller, buyer2, pc } = accounts;

    // +200%: the short's loss exceeds its collateral. A full close must still
    // succeed (guard skipped once the position is gone) and surface bad debt.
    await data.pump(3n, 1n);

    const hash = await perps.write.liquidatePosition([seller.account.address, maxUint256], {
      account: buyer2.account,
    });
    const receipt = await pc.waitForTransactionReceipt({ hash });

    const pos = await perps.read.getUserPosition([seller.account.address]);
    assert.equal(pos.netQuantity, 0n, "deep-underwater position fully closes");

    const badDebt = parseEventLogs({ logs: receipt.logs, abi: perps.abi, eventName: "BadDebt" });
    assert.ok(badDebt.length >= 1, "expected a BadDebt event on the bad-debt full close");
  });

  it("emits PositionLiquidated carrying the partial closedQuantity + realized pnl", async function () {
    const data = await networkHelpers.loadFixture(partialPerpsFixture);
    const { contracts, accounts, config } = data;
    const { perps } = contracts;
    const { seller, buyer2, pc } = accounts;

    await data.pump(13n, 10n);

    const closeQty = parseUnits("30", config.quantityDecimals);
    const hash = await perps.write.liquidatePosition([seller.account.address, closeQty], {
      account: buyer2.account,
    });
    const receipt = await pc.waitForTransactionReceipt({ hash });

    const [event] = parseEventLogs({
      logs: receipt.logs,
      abi: perps.abi,
      eventName: "PositionLiquidated",
    });
    assert.ok(event, "expected a PositionLiquidated event");
    // Short position → the closed quantity is signed negative.
    assert.equal(event.args.positionSize, -closeQty, "closedQuantity should be the partial (signed) qty");
    // A short losing into a pump realizes a loss (pnl < 0).
    assert.ok(event.args.pnl < 0n, "expected a realized loss on the closed portion");
  });

  // ── Liquidation fee: `_chargeLiquidationFee` takes `liquidationFeeBps` of the closed
  //    notional (capped at the user's balance) and emits it as
  //    `PositionLiquidated.liquidatorFee`. The liquidator's cut is
  //    `liquidatorShareBps * fee` — default 0, so at default config the whole fee
  //    becomes venue revenue and the keeper's balance is unchanged.

  it("charges the bps fee on a restoring partial close; liquidator share defaults to 0", async function () {
    const data = await networkHelpers.loadFixture(partialPerpsFixture);
    const { contracts, accounts, config } = data;
    const { perps, vault } = contracts;
    const { seller, buyer2, owner } = accounts;

    const feeBps = 50n; // 0.5%
    await perps.write.setLiquidationFeeBps([Number(feeBps)], { account: owner.account });

    const newMark = await data.pump(13n, 10n); // +30% — closing 30 lands in [MM, IM]
    const before = await vault.read.balanceOf([buyer2.account.address]);
    const revenueBefore = await perps.read.collectedFeesBalance();

    const closeQty = parseUnits("30", config.quantityDecimals);
    const hash = await perps.write.liquidatePosition([seller.account.address, closeQty], {
      account: buyer2.account,
    });
    const receipt = await accounts.pc.waitForTransactionReceipt({ hash });

    const [event] = parseEventLogs({ logs: receipt.logs, abi: perps.abi, eventName: "PositionLiquidated" });
    const closedNotional = (newMark * closeQty) / 10n ** BigInt(config.quantityDecimals);
    const expectedFee = (closedNotional * feeBps) / 10_000n;
    assert.equal(event.args.liquidatorFee, expectedFee, "total fee = closed notional × bps");

    const after = await vault.read.balanceOf([buyer2.account.address]);
    assert.equal(after, before, "liquidator balance unchanged (share defaults to 0)");
    assert.equal(await perps.read.collectedFeesBalance(), revenueBefore + expectedFee);
  });

  it("charges the bps fee on a full close; liquidator share defaults to 0", async function () {
    const data = await networkHelpers.loadFixture(partialPerpsFixture);
    const { contracts, accounts, config } = data;
    const { perps, vault } = contracts;
    const { seller, buyer2, owner } = accounts;

    const feeBps = 50n; // 0.5%
    await perps.write.setLiquidationFeeBps([Number(feeBps)], { account: owner.account });

    const newMark = await data.pump(13n, 10n);
    const before = await vault.read.balanceOf([buyer2.account.address]);
    const revenueBefore = await perps.read.collectedFeesBalance();

    const hash = await perps.write.liquidatePosition([seller.account.address, maxUint256], {
      account: buyer2.account,
    });
    const receipt = await accounts.pc.waitForTransactionReceipt({ hash });

    const pos = await perps.read.getUserPosition([seller.account.address]);
    assert.equal(pos.netQuantity, 0n, "fully closed");

    const [event] = parseEventLogs({ logs: receipt.logs, abi: perps.abi, eventName: "PositionLiquidated" });
    const closedNotional = (newMark * config.qty) / 10n ** BigInt(config.quantityDecimals);
    const expectedFee = (closedNotional * feeBps) / 10_000n;
    assert.equal(event.args.liquidatorFee, expectedFee, "total fee = closed notional × bps");

    const after = await vault.read.balanceOf([buyer2.account.address]);
    assert.equal(after, before, "liquidator balance unchanged (share defaults to 0)");
    assert.equal(await perps.read.collectedFeesBalance(), revenueBefore + expectedFee);
  });

  it("degenerate IM <= MM: no over-liquidation ceiling even when over-closing", async function () {
    const data = await networkHelpers.loadFixture(partialPerpsFixture);
    const { contracts, accounts, config } = data;
    const { perps, pme } = contracts;
    const { seller, buyer2, owner } = accounts;

    // Collapse the buffer: IM == MM. The OverLiquidation guard's `im > mm`
    // precondition fails, so the oversize request is allowed.
    const shock = parseUnits("0.05", 18);
    await pme.write.setShocks([shock, shock, 0n, 0n], { account: owner.account });

    await data.pump(13n, 10n);

    const tooMuch = parseUnits("38", config.quantityDecimals);
    await perps.write.liquidatePosition([seller.account.address, tooMuch], {
      account: buyer2.account,
    });

    const pos = await perps.read.getUserPosition([seller.account.address]);
    assert.equal(pos.netQuantity, -(config.qty - tooMuch), "residual 2-qty short remains, no revert");
  });
});
