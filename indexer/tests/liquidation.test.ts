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
import { positionSessionId } from "../src/ids";

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
  positionSize: BigInt,
  pnl: BigInt,
  liquidatorFee: BigInt,
  logIndex: i32 = 1,
): PositionLiquidated {
  const event = newTypedMockEventWithParams<PositionLiquidated>([
    paramAddr("user", user),
    paramAddr("liquidator", liquidator),
    paramInt("positionSize", positionSize),
    paramInt("pnl", pnl),
    paramUint("liquidatorFee", liquidatorFee),
  ]);
  event.logIndex = BigInt.fromI32(logIndex);
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

    const sessionId = positionSessionId(BigInt.fromI32(1), 1 * 2);
    assert.fieldEquals("PositionSession", sessionId, "status", "OPEN");

    const liqEvent = createPositionLiquidatedEvent(trader, liquidator, qty, pnl, liqFee);
    handlePositionLiquidated(liqEvent);

    // The dedicated Liquidation entity was dropped; the flagged liquidation
    // Trade (asserted in the integration harness) is now the source of truth.
    // The unit test keeps the totalLiquidations counter, user-reset, and
    // PositionSession-close coverage below.

    // User reset
    assert.fieldEquals("User", trader.toHexString(), "netQuantity", "0");
    assert.fieldEquals("User", trader.toHexString(), "aggregatedEntryPrice", "0");
    assert.fieldEquals("User", trader.toHexString(), "currentPositionSessionId", "");
    assert.fieldEquals("User", trader.toHexString(), "realizedPnl", pnl.toString());
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
    assert.fieldEquals(
      "PositionSession",
      sessionId,
      "lastTradeAt",
      liqEvent.block.timestamp.toString(),
    );

    // Perps stats
    assert.fieldEquals("Perps", "0", "totalLiquidations", "1");
    assert.fieldEquals("Perps", "0", "lastUpdatedAt", liqEvent.block.timestamp.toString());
  });
});
