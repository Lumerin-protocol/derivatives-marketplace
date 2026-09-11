import { describe, test, beforeEach, clearStore } from "matchstick-as/assembly/index";
import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts";
import { newTypedMockEventWithParams } from "matchstick-as/assembly/defaults";
import { handleOrderMatched, handlePositionLiquidated } from "../src/perps";
import { OrderMatched, PositionLiquidated } from "../generated/HashPowerPerpsDEX/HashPowerPerpsDEX";
import { assert } from "matchstick-as/assembly/index";
import {
  userAddress,
  orderId,
  paramAddr,
  paramBytes,
  paramUint,
  paramInt,
  setupDataSourceMock,
  setupPerps,
} from "./helpers";
import { positionSessionId, tradeId } from "../src/ids";

function openLongPosition(
  trader: Address,
  maker: Address,
  price: BigInt,
  qty: BigInt,
  oid: Bytes,
  txHash: Bytes,
  logIndex: i32,
): void {
  const zero = BigInt.zero();
  const event = newTypedMockEventWithParams<OrderMatched>([
    paramBytes("makerOrderId", oid),
    paramAddr("maker", maker),
    paramAddr("taker", trader),
    paramUint("tradePrice", price),
    paramInt("takerQuantity", qty),
    paramInt("makerFee", zero),
    paramInt("takerFee", zero),
    paramInt("makerNetQtyAfter", qty.neg()),
    paramInt("takerNetQtyAfter", qty),
    paramUint("makerEntryPriceAfter", price),
    paramUint("takerEntryPriceAfter", price),
  ]);
  event.logIndex = BigInt.fromI32(logIndex);
  event.transaction.hash = txHash;
  handleOrderMatched(event);
}

function createPositionLiquidatedEvent(
  user: Address,
  liquidator: Address,
  closedQuantity: BigInt,
  pnl: BigInt,
  liquidatorFee: BigInt,
  txHash: Bytes,
  logIndex: i32 = 1,
): PositionLiquidated {
  const event = newTypedMockEventWithParams<PositionLiquidated>([
    paramAddr("user", user),
    paramAddr("liquidator", liquidator),
    paramInt("closedQuantity", closedQuantity),
    paramInt("pnl", pnl),
    paramUint("liquidatorFee", liquidatorFee),
  ]);
  event.logIndex = BigInt.fromI32(logIndex);
  event.transaction.hash = txHash;
  return event;
}

describe("handlePositionLiquidated", () => {
  beforeEach(() => {
    clearStore();
    setupDataSourceMock();
    setupPerps();
  });

  test("liquidates open long and asserts all fields", () => {
    const trader = userAddress(1);
    const maker = userAddress(2);
    const liquidator = userAddress(3);
    const entryPrice = BigInt.fromI32(3000000);
    const qty = BigInt.fromI32(1000000);
    const pnl = BigInt.fromI32(-200000);
    const liqFee = BigInt.fromI32(10000);

    openLongPosition(trader, maker, entryPrice, qty, orderId(1), orderId(100), 1);

    const sessionId = positionSessionId(BigInt.fromI32(1), BigInt.fromI32(1), 0);
    assert.fieldEquals("PositionSession", sessionId, "status", "OPEN");

    const liqEvent = createPositionLiquidatedEvent(
      trader,
      liquidator,
      qty,
      pnl,
      liqFee,
      orderId(200),
    );
    handlePositionLiquidated(liqEvent);

    // The dedicated Liquidation entity was dropped; the flagged liquidation
    // Trade (asserted in the integration harness) is now the source of truth.
    // The unit test keeps the totalLiquidations counter, user-reset, and
    // PositionSession-close coverage below.

    // User reset
    assert.fieldEquals("User", trader.toHexString(), "netQuantity", "0");
    assert.fieldEquals("User", trader.toHexString(), "aggregatedEntryPrice", "0");
    assert.fieldEquals("User", trader.toHexString(), "currentSessionId", "");
    assert.fieldEquals("User", trader.toHexString(), "realizedPnl", pnl.toString());
    assert.fieldEquals(
      "Trade",
      tradeId(liqEvent.transaction.hash, trader, sessionId).toHexString(),
      "cumulativeRealizedPnl",
      pnl.toString(),
    );
    assert.fieldEquals(
      "User",
      trader.toHexString(),
      "lastActivityAt",
      liqEvent.block.timestamp.toString(),
    );

    // Liquidator
    assert.fieldEquals(
      "User",
      liquidator.toHexString(),
      "lastActivityAt",
      liqEvent.block.timestamp.toString(),
    );

    // PositionSession closed
    assert.fieldEquals("PositionSession", sessionId, "status", "CLOSE");
    assert.fieldEquals("PositionSession", sessionId, "netQuantity", "0");
    assert.fieldEquals(
      "PositionSession",
      sessionId,
      "lastTradeAt",
      liqEvent.block.timestamp.toString(),
    );

    // Perps stats. exitPrice = entry + pnl * scale / closedQuantity
    //   = 3000000 - 200000 = 2800000, so the notional closed by force is
    //   2800000 * 1000000 / 1000000 = 2800000.
    assert.fieldEquals("Perps", "0", "totalLiquidatedValue", "2800000");
    assert.fieldEquals("Perps", "0", "totalLiquidations", "1");
    assert.fieldEquals("Perps", "0", "lastUpdatedAt", liqEvent.block.timestamp.toString());
  });

  test("partially liquidates a long: reduces netQuantity and keeps the session open", () => {
    const trader = userAddress(1);
    const maker = userAddress(2);
    const liquidator = userAddress(3);
    const entryPrice = BigInt.fromI32(3000000);
    const qty = BigInt.fromI32(40000000); // long 40
    const closed = BigInt.fromI32(31000000); // partial close 31 (same sign as position)
    const remaining = qty.minus(closed); // 9 left open
    const pnl = BigInt.fromI32(-100000);
    const liqFee = BigInt.fromI32(10000);

    openLongPosition(trader, maker, entryPrice, qty, orderId(1), orderId(100), 1);
    const sessionId = positionSessionId(BigInt.fromI32(1), BigInt.fromI32(1), 0);
    assert.fieldEquals("PositionSession", sessionId, "status", "OPEN");

    const liqEvent = createPositionLiquidatedEvent(
      trader,
      liquidator,
      closed,
      pnl,
      liqFee,
      orderId(200),
    );
    handlePositionLiquidated(liqEvent);

    // User position REDUCED, not reset: netQuantity drops by the closed slice,
    // entry price is unchanged (a reducing close doesn't re-average), and the
    // session link is preserved so the residual keeps accruing to it.
    assert.fieldEquals("User", trader.toHexString(), "netQuantity", remaining.toString());
    assert.fieldEquals("User", trader.toHexString(), "aggregatedEntryPrice", entryPrice.toString());
    assert.fieldEquals("User", trader.toHexString(), "currentSessionId", sessionId);
    assert.fieldEquals("User", trader.toHexString(), "realizedPnl", pnl.toString());
    assert.fieldEquals(
      "Trade",
      tradeId(liqEvent.transaction.hash, trader, sessionId).toHexString(),
      "cumulativeRealizedPnl",
      pnl.toString(),
    );

    // Session stays OPEN and records the partially-closed / liquidated slice.
    assert.fieldEquals("PositionSession", sessionId, "status", "OPEN");
    assert.fieldEquals("PositionSession", sessionId, "netQuantity", remaining.toString());
    assert.fieldEquals("PositionSession", sessionId, "closedQuantity", closed.toString());
    assert.fieldEquals("PositionSession", sessionId, "liquidatedQuantity", closed.toString());

    assert.fieldEquals("Perps", "0", "totalLiquidations", "1");
  });

  test("partial then full close: second liquidation resets the position", () => {
    const trader = userAddress(1);
    const maker = userAddress(2);
    const liquidator = userAddress(3);
    const entryPrice = BigInt.fromI32(3000000);
    const qty = BigInt.fromI32(40000000);
    const firstClose = BigInt.fromI32(31000000);
    const remaining = qty.minus(firstClose); // 9

    openLongPosition(trader, maker, entryPrice, qty, orderId(1), orderId(100), 1);
    const sessionId = positionSessionId(BigInt.fromI32(1), BigInt.fromI32(1), 0);

    handlePositionLiquidated(
      createPositionLiquidatedEvent(
        trader,
        liquidator,
        firstClose,
        BigInt.fromI32(-100000),
        BigInt.zero(),
        orderId(200),
        1,
      ),
    );
    assert.fieldEquals("User", trader.toHexString(), "netQuantity", remaining.toString());
    assert.fieldEquals("PositionSession", sessionId, "status", "OPEN");

    // Second call, in a separate tx, closes the residual entirely → full reset
    // + session CLOSE.
    handlePositionLiquidated(
      createPositionLiquidatedEvent(
        trader,
        liquidator,
        remaining,
        BigInt.fromI32(-20000),
        BigInt.zero(),
        orderId(201),
        2,
      ),
    );
    assert.fieldEquals("User", trader.toHexString(), "netQuantity", "0");
    assert.fieldEquals("User", trader.toHexString(), "aggregatedEntryPrice", "0");
    assert.fieldEquals("User", trader.toHexString(), "currentSessionId", "");
    assert.fieldEquals("PositionSession", sessionId, "status", "CLOSE");
    assert.fieldEquals("PositionSession", sessionId, "closedQuantity", qty.toString());
    assert.fieldEquals("Perps", "0", "totalLiquidations", "2");
  });

  test("two position legs in one tx count as a single liquidation", () => {
    const traderA = userAddress(1);
    const traderB = userAddress(4);
    const maker = userAddress(2);
    const liquidator = userAddress(3);
    const entryPrice = BigInt.fromI32(3000000);
    const qty = BigInt.fromI32(1000000);
    const liqTx = orderId(200);

    openLongPosition(traderA, maker, entryPrice, qty, orderId(1), orderId(100), 1);
    openLongPosition(traderB, maker, entryPrice, qty, orderId(2), orderId(101), 2);

    // A keeper sweeping two underwater positions emits one PositionLiquidated
    // per position, all within the same tx.
    handlePositionLiquidated(
      createPositionLiquidatedEvent(
        traderA,
        liquidator,
        qty,
        BigInt.fromI32(-100000),
        BigInt.zero(),
        liqTx,
        1,
      ),
    );
    handlePositionLiquidated(
      createPositionLiquidatedEvent(
        traderB,
        liquidator,
        qty,
        BigInt.fromI32(-100000),
        BigInt.zero(),
        liqTx,
        2,
      ),
    );

    assert.fieldEquals("Perps", "0", "totalLiquidations", "1");
    assert.entityCount("LiquidationTx", 1);
  });
});
