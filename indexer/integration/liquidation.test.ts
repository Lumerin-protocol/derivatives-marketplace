/**
 * Integration test: a perps position liquidation is modeled as a forced Trade
 * carrying `isLiquidation` + `liquidator` + `liquidationFee`, with the closing
 * `PositionSession` denormalizing `liquidatedQuantity`.
 *
 * Drives the real `HashPowerPerpsDEX`:
 *   - fixture opens a seller short / buyer long at `initialPrice`,
 *   - `makeLiquidatable()` doubles the oracle price so the short is underwater,
 *   - `liquidatePosition(seller, maxUint256)` fully closes and emits a real `PositionLiquidated`.
 *
 * The harness replays the open `OrderMatched` (no `anchor()` discard) + the
 * `PositionLiquidated` through `src/perps.ts`, and we assert the resulting
 * Trade / PositionSession entities.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { maxUint256, parseEventLogs } from "viem";
import type { EntityFields } from "matchstick-ts";
import { deployPerpsWithLiquidatablePositionFixture } from "../../contracts/tests/fixtures.ts";

const conn = await network.getOrCreate();
const { matchstick } = conn;

describe("liquidatePosition: forced Trade with isLiquidation + session liquidatedQuantity", () => {
  after(() => matchstick.reset());

  it("creates a flagged closing Trade and denormalizes liquidatedQuantity onto the session", async () => {
    const fixture = await conn.networkHelpers.loadFixture(
      deployPerpsWithLiquidatablePositionFixture,
    );
    const { contracts, accounts, config } = fixture;
    const { perps } = contracts;
    const { seller, owner, pc } = accounts;

    // Bind + capture view mocks AFTER the fixture opened the position. We do
    // NOT anchor(), so the fixture's open `OrderMatched` is replayed alongside
    // the liquidation (anchor() would discard it).
    matchstick.bind("HashPowerPerpsDEX", perps.address, perps.abi);
    await matchstick.captureViewMocks();

    // Double the oracle price → the seller's short is underwater.
    await fixture.makeLiquidatable();

    // Permissionless liquidation; `owner` is the keeper/liquidator (msg.sender).
    // `maxUint256` clamps to |netQty| → a full close (this scenario is a deep,
    // fully-underwater short after the 2× price move).
    const liqTx = await perps.write.liquidatePosition([seller.account.address, maxUint256], {
      account: owner.account,
    });
    const liqReceipt = await pc.waitForTransactionReceipt({ hash: liqTx });

    const [liquidated] = parseEventLogs({
      logs: liqReceipt.logs,
      abi: perps.abi,
      eventName: "PositionLiquidated",
    });
    assert.ok(liquidated, "liquidatePosition must emit PositionLiquidated");

    const sellerAddr = seller.account.address.toLowerCase() as `0x${string}`;
    const ownerAddr = owner.account.address.toLowerCase() as `0x${string}`;

    // On-chain event values: positionSize is the SIGNED closed position
    // (seller short → negative); pnl/fee are signed/unsigned respectively.
    const positionSize = liquidated.args.positionSize as bigint; // signed, negative
    const pnl = liquidated.args.pnl as bigint;
    const liquidatorFee = liquidated.args.liquidatorFee as bigint;
    assert.equal(
      String(liquidated.args.user).toLowerCase(),
      sellerAddr,
      "the liquidated user is the underwater seller",
    );
    assert.ok(positionSize < 0n, "seller short → signed positionSize is negative");

    // Exit price derived from the event the same way the indexer must:
    //   exit = entry + pnl * 10^quantityDecimals / positionSize
    // using the seller's entry price (= the match price = initialPrice).
    const scale = 10n ** BigInt(config.quantityDecimals);
    const expectedExitPrice = config.initialPrice + (pnl * scale) / positionSize;

    const snap = await matchstick.indexSnapshot([]);

    // ---- The forced closing Trade (single source of truth) ----
    let liqTrade: EntityFields | undefined;
    for (const t of snap.saved("Trade")) {
      if (
        String(t.user).toLowerCase() === sellerAddr &&
        String(t.transactionHash).toLowerCase() === liqTx.toLowerCase()
      ) {
        liqTrade = t;
      }
    }
    assert.ok(liqTrade, "a Trade must be created for the seller in the liquidation tx");

    assert.equal(liqTrade.isLiquidation, true, "Trade.isLiquidation must be true");
    assert.equal(
      String(liqTrade.liquidator).toLowerCase(),
      ownerAddr,
      "Trade.liquidator must be the liquidation caller",
    );
    assert.equal(
      String(liqTrade.liquidationFee),
      liquidatorFee.toString(),
      "Trade.liquidationFee must mirror PositionLiquidated.liquidatorFee",
    );
    assert.equal(
      String(liqTrade.realizedPnl),
      pnl.toString(),
      "Trade.realizedPnl must equal the event pnl",
    );
    assert.equal(
      String(liqTrade.netQuantityAfter),
      "0",
      "Trade.netQuantityAfter must be 0 (full close)",
    );
    assert.equal(
      String(liqTrade.tradePrice),
      expectedExitPrice.toString(),
      "Trade.tradePrice must be the derived exit price",
    );
    // The forced trade offsets the closed position, so its signed quantity is
    // the OPPOSITE sign of the closed position (short close → forced buy → +).
    assert.equal(
      String(liqTrade.tradeQuantity),
      (-positionSize).toString(),
      "Trade.tradeQuantity is the offsetting forced trade (-positionSize)",
    );

    // ---- The closing PositionSession ----
    const sessionId = String(liqTrade.positionSession);
    assert.ok(sessionId.length > 0, "Trade.positionSession must link the closing session");
    const session = snap.entity("PositionSession", sessionId);
    assert.ok(session, "the closing PositionSession must exist");
    assert.equal(String(session.user).toLowerCase(), sellerAddr, "session belongs to the seller");
    assert.equal(session.status, "CLOSE", "session must be CLOSE after liquidation");
    assert.equal(
      String(session.liquidatedQuantity),
      (-positionSize).toString(),
      "PositionSession.liquidatedQuantity == abs(closed qty)",
    );
    assert.equal(
      String(session.closedQuantity),
      (-positionSize).toString(),
      "session.closedQuantity == abs(closed qty) after the full liquidation close",
    );
    assert.equal(
      String(session.realizedPnl),
      pnl.toString(),
      "session.realizedPnl accrues the liquidation pnl",
    );
    assert.equal(
      String(session.closePrice),
      expectedExitPrice.toString(),
      "session.closePrice == derived exit price",
    );

    // ---- Counter is still bumped (kept alongside the Trade) ----
    const perpsEntity = snap.entity("Perps", "0");
    assert.ok(perpsEntity);
    assert.equal(
      String(perpsEntity.totalLiquidations),
      "1",
      "Perps.totalLiquidations bumps once per liquidation",
    );
  });
});
