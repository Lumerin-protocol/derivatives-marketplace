import { describe, test, beforeEach, clearStore } from "matchstick-as/assembly/index";
import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts";
import { newTypedMockEventWithParams } from "matchstick-as/assembly/defaults";
import { handleDriftSettled, handleDriftUpdated, handleOrderMatched } from "../src/perps";
import { DriftSettled, DriftUpdated, OrderMatched } from "../generated/HashPowerPerpsDEX/HashPowerPerpsDEX";
import { assert } from "matchstick-as/assembly/index";
import { userAddress, orderId, paramAddr, paramBytes, paramUint, paramInt, setupDataSourceMock, mockEventId, setupPerps } from "./helpers";
import { positionSessionId } from "../src/ids";

/** `trader` takes `qty` (signed) against `maker` at `price`, leaving it at `after`. */
function match(
  trader: Address,
  maker: Address,
  price: BigInt,
  qty: BigInt,
  after: BigInt,
  entryAfter: BigInt,
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
    paramInt("makerNetQtyAfter", after.neg()),
    paramInt("takerNetQtyAfter", after),
    paramUint("makerEntryPriceAfter", after.equals(zero) ? zero : price),
    paramUint("takerEntryPriceAfter", entryAfter),
  ]);
  event.logIndex = BigInt.fromI32(logIndex);
  event.transaction.hash = txHash;
  handleOrderMatched(event);
}

/** `amount` as the contract emits it: positive = the user gains. */
function createDriftSettledEvent(user: Address, amount: BigInt, logIndex: i32): DriftSettled {
  const event = newTypedMockEventWithParams<DriftSettled>([
    paramAddr("user", user),
    paramInt("amount", amount),
  ]);
  event.logIndex = BigInt.fromI32(logIndex);
  return event;
}

describe("handleDriftSettled", () => {
  beforeEach(() => {
    clearStore();
    setupDataSourceMock();
    setupPerps();
  });

  test("links settlement to the open session and keeps running totals", () => {
    const trader = userAddress(1);
    const maker = userAddress(2);
    const price = BigInt.fromI32(3000000);
    const oneUnit = BigInt.fromI32(1000000);
    const gain = BigInt.fromI32(50000);
    const loss = BigInt.fromI32(-20000);

    match(trader, maker, price, oneUnit, oneUnit, price, orderId(1), orderId(100), 1);
    const sessionId = positionSessionId(BigInt.fromI32(1), BigInt.fromI32(1), 0);

    handleDriftSettled(createDriftSettledEvent(trader, gain, 2));
    handleDriftSettled(createDriftSettledEvent(trader, loss, 3));

    assert.entityCount("DriftSettlement", 2);
    assert.fieldEquals("DriftSettlement", mockEventId(2), "positionSession", sessionId);
    assert.fieldEquals("DriftSettlement", mockEventId(2), "amount", gain.toString());
    assert.fieldEquals("DriftSettlement", mockEventId(2), "cumulativeDriftReceived", gain.toString());
    assert.fieldEquals("DriftSettlement", mockEventId(2), "cumulativeDriftPaid", "0");
    assert.fieldEquals("DriftSettlement", mockEventId(3), "amount", loss.toString());
    assert.fieldEquals("DriftSettlement", mockEventId(3), "cumulativeDriftReceived", gain.toString());
    assert.fieldEquals("DriftSettlement", mockEventId(3), "cumulativeDriftPaid", loss.abs().toString());

    assert.fieldEquals("PositionSession", sessionId, "driftPayments", gain.plus(loss).toString());
    assert.fieldEquals("User", trader.toHexString(), "totalDriftReceived", gain.toString());
    assert.fieldEquals("User", trader.toHexString(), "totalDriftPaid", loss.abs().toString());
  });

  test("a long's gain lowers its entry, and the close realizes it", () => {
    const trader = userAddress(1);
    const maker = userAddress(2);
    const entry = BigInt.fromI32(3000000);
    const exit = BigInt.fromI32(3100000);
    const oneUnit = BigInt.fromI32(1000000);
    const gain = BigInt.fromI32(50000);

    match(trader, maker, entry, oneUnit, oneUnit, entry, orderId(1), orderId(100), 1);
    const sessionId = positionSessionId(BigInt.fromI32(1), BigInt.fromI32(1), 0);

    handleDriftSettled(createDriftSettledEvent(trader, gain, 2));

    const driftedEntry = entry.minus(gain);
    assert.fieldEquals("User", trader.toHexString(), "aggregatedEntryPrice", driftedEntry.toString());
    assert.fieldEquals("PositionSession", sessionId, "entryPrice", driftedEntry.toString());

    match(trader, userAddress(3), exit, oneUnit.neg(), BigInt.zero(), BigInt.zero(), orderId(2), orderId(101), 3);

    // (exit − drifted entry) × 1 unit: the price move plus the drift.
    assert.fieldEquals("PositionSession", sessionId, "status", "CLOSE");
    assert.fieldEquals("PositionSession", sessionId, "realizedPnl", exit.minus(driftedEntry).toString());
    assert.fieldEquals("PositionSession", sessionId, "driftPayments", gain.toString());
  });

  test("a short's gain raises its entry", () => {
    const trader = userAddress(1);
    const maker = userAddress(2);
    const entry = BigInt.fromI32(3000000);
    const oneUnit = BigInt.fromI32(1000000);
    const gain = BigInt.fromI32(50000);

    match(trader, maker, entry, oneUnit.neg(), oneUnit.neg(), entry, orderId(1), orderId(100), 1);

    handleDriftSettled(createDriftSettledEvent(trader, gain, 2));

    assert.fieldEquals("User", trader.toHexString(), "aggregatedEntryPrice", entry.plus(gain).toString());
  });
});

describe("handleDriftUpdated", () => {
  beforeEach(() => {
    clearStore();
    setupDataSourceMock();
    setupPerps();
  });

  test("records the update and the running per-unit sum", () => {
    const delta = BigInt.fromI32(-1200);
    const cumulative = BigInt.fromI32(-3600);
    const event = newTypedMockEventWithParams<DriftUpdated>([
      paramInt("delta", delta),
      paramInt("cumulativePerUnit", cumulative),
    ]);
    event.logIndex = BigInt.fromI32(1);
    handleDriftUpdated(event);

    assert.entityCount("DriftUpdate", 1);
    assert.fieldEquals("DriftUpdate", mockEventId(1), "delta", delta.toString());
    assert.fieldEquals("DriftUpdate", mockEventId(1), "cumulativePerUnit", cumulative.toString());
    assert.fieldEquals("Perps", "0", "cumulativeDriftPerUnit", cumulative.toString());
  });
});
