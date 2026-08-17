import {
  describe,
  test,
  beforeEach,
  clearStore,
  assert,
} from "matchstick-as/assembly/index";
import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts";
import { newTypedMockEventWithParams } from "matchstick-as/assembly/defaults";
import {
  handleOrderCancelled,
  handleOrderCreated,
  handleOrderMatched,
  handleOrderUpdated,
} from "../src/perps";
import {
  OrderCancelled,
  OrderCreated,
  OrderMatched,
  OrderUpdated,
} from "../generated/HashPowerPerpsDEX/HashPowerPerpsDEX";
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
import { createEventId } from "../src/ids";

function createOrderCreatedEvent(
  orderIdBytes: Bytes,
  participant: Address,
  price: BigInt,
  quantity: BigInt,
): OrderCreated {
  return newTypedMockEventWithParams<OrderCreated>([
    paramBytes("orderId", orderIdBytes),
    paramAddr("participant", participant),
    paramUint("price", price),
    paramInt("quantity", quantity),
  ]);
}

function createOrderUpdatedEvent(
  orderIdBytes: Bytes,
  participant: Address,
  newQuantity: BigInt,
): OrderUpdated {
  return newTypedMockEventWithParams<OrderUpdated>([
    paramBytes("orderId", orderIdBytes),
    paramAddr("participant", participant),
    paramInt("newQuantity", newQuantity),
  ]);
}

function createOrderCancelledEvent(
  orderIdBytes: Bytes,
  participant: Address,
): OrderCancelled {
  return newTypedMockEventWithParams<OrderCancelled>([
    paramBytes("orderId", orderIdBytes),
    paramAddr("participant", participant),
  ]);
}

function createOrderMatchedEvent(
  makerOrderId: Bytes,
  maker: Address,
  taker: Address,
  tradePrice: BigInt,
  takerQuantity: BigInt,
  makerNetQtyAfter: BigInt,
  takerNetQtyAfter: BigInt,
  makerEntryPriceAfter: BigInt,
  takerEntryPriceAfter: BigInt,
  logIndex: i32,
): OrderMatched {
  const event = newTypedMockEventWithParams<OrderMatched>([
    paramBytes("makerOrderId", makerOrderId),
    paramAddr("maker", maker),
    paramAddr("taker", taker),
    paramUint("tradePrice", tradePrice),
    paramInt("takerQuantity", takerQuantity),
    paramInt("makerFee", BigInt.zero()),
    paramInt("takerFee", BigInt.zero()),
    paramInt("makerNetQtyAfter", makerNetQtyAfter),
    paramInt("takerNetQtyAfter", takerNetQtyAfter),
    paramUint("makerEntryPriceAfter", makerEntryPriceAfter),
    paramUint("takerEntryPriceAfter", takerEntryPriceAfter),
  ]);
  event.logIndex = BigInt.fromI32(logIndex);
  return event;
}

describe("Order ↔ Fill relation and averageFillPrice", () => {
  beforeEach(() => {
    clearStore();
    setupDataSourceMock();
    setupPerps();
  });

  test("single full fill: averageFillPrice = trade price, both fills reference correct orders", () => {
    const maker = userAddress(1);
    const taker = userAddress(2);
    const makerOid = orderId(1);
    const takerOid = orderId(2);
    const price = BigInt.fromI32(3000000);
    const qty = BigInt.fromI32(1000000);

    // Maker rests first
    handleOrderCreated(createOrderCreatedEvent(makerOid, maker, price, qty.neg()));
    // Taker comes in and fully matches
    handleOrderCreated(createOrderCreatedEvent(takerOid, taker, price, qty));
    const matchEvent = createOrderMatchedEvent(
      makerOid, maker, taker, price, qty,
      BigInt.zero(), qty, BigInt.zero(), price,
      0,
    );
    handleOrderMatched(matchEvent);
    // Maker fully filled (per-match) and then taker fully filled
    handleOrderUpdated(createOrderUpdatedEvent(makerOid, maker, BigInt.zero()));
    handleOrderUpdated(createOrderUpdatedEvent(takerOid, taker, BigInt.zero()));

    assert.fieldEquals("Order", makerOid.toHexString(), "averageFillPrice", price.toString());
    assert.fieldEquals("Order", makerOid.toHexString(), "filledQuantity", qty.toString());
    assert.fieldEquals("Order", makerOid.toHexString(), "status", "FILLED");

    assert.fieldEquals("Order", takerOid.toHexString(), "averageFillPrice", price.toString());
    assert.fieldEquals("Order", takerOid.toHexString(), "filledQuantity", qty.toString());
    assert.fieldEquals("Order", takerOid.toHexString(), "status", "FILLED");

    const baseId = createEventId(matchEvent.transaction.hash, matchEvent.logIndex);
    const takerFillId = baseId.concatI32(0).toHexString();
    const makerFillId = baseId.concatI32(1).toHexString();

    // Each side's Fill should point to that side's own order
    assert.fieldEquals("Fill", takerFillId, "order", takerOid.toHexString());
    assert.fieldEquals("Fill", makerFillId, "order", makerOid.toHexString());
  });

  test("taker sweeps two makers at different prices: averageFillPrice is VWAP", () => {
    const makerA = userAddress(1);
    const makerB = userAddress(2);
    const taker = userAddress(3);
    const makerAOid = orderId(1);
    const makerBOid = orderId(2);
    const takerOid = orderId(3);

    // Maker A: 600 @ 3,000,000  (better price, fills first)
    // Maker B: 400 @ 3,100,000
    const priceA = BigInt.fromI32(3000000);
    const priceB = BigInt.fromI32(3100000);
    const qtyA = BigInt.fromI32(600000);
    const qtyB = BigInt.fromI32(400000);
    const takerQty = qtyA.plus(qtyB); // 1,000,000

    handleOrderCreated(createOrderCreatedEvent(makerAOid, makerA, priceA, qtyA.neg()));
    handleOrderCreated(createOrderCreatedEvent(makerBOid, makerB, priceB, qtyB.neg()));
    handleOrderCreated(createOrderCreatedEvent(takerOid, taker, priceB, takerQty));

    // Match 1: taker fills maker A fully at priceA
    const match1 = createOrderMatchedEvent(
      makerAOid, makerA, taker, priceA, qtyA,
      BigInt.zero(), qtyA, BigInt.zero(), priceA,
      0,
    );
    handleOrderMatched(match1);
    handleOrderUpdated(createOrderUpdatedEvent(makerAOid, makerA, BigInt.zero()));

    // Match 2: taker fills maker B fully at priceB
    // Taker net after = qtyA + qtyB; entry price = VWAP(priceA, priceB) weighted by qty
    const expectedTakerEntry = priceA.times(qtyA).plus(priceB.times(qtyB)).div(takerQty);
    const match2 = createOrderMatchedEvent(
      makerBOid, makerB, taker, priceB, qtyB,
      BigInt.zero(), takerQty, BigInt.zero(), expectedTakerEntry,
      1,
    );
    handleOrderMatched(match2);
    handleOrderUpdated(createOrderUpdatedEvent(makerBOid, makerB, BigInt.zero()));

    // Taker fully filled at the end of the tx
    handleOrderUpdated(createOrderUpdatedEvent(takerOid, taker, BigInt.zero()));

    // Maker A only saw one fill at priceA
    assert.fieldEquals("Order", makerAOid.toHexString(), "averageFillPrice", priceA.toString());
    assert.fieldEquals("Order", makerAOid.toHexString(), "filledQuantity", qtyA.toString());

    // Maker B only saw one fill at priceB
    assert.fieldEquals("Order", makerBOid.toHexString(), "averageFillPrice", priceB.toString());
    assert.fieldEquals("Order", makerBOid.toHexString(), "filledQuantity", qtyB.toString());

    // Taker saw two fills: VWAP across both
    const expectedVwap = priceA.times(qtyA).plus(priceB.times(qtyB)).div(takerQty);
    assert.fieldEquals("Order", takerOid.toHexString(), "averageFillPrice", expectedVwap.toString());
    assert.fieldEquals("Order", takerOid.toHexString(), "filledQuantity", takerQty.toString());

    // Each match emits 2 Fills (taker side + maker side), each carrying both order refs:
    //   `order`             = the user's own order
    //   `counterpartyOrder` = the other side's order
    const base1 = createEventId(match1.transaction.hash, match1.logIndex);
    const base2 = createEventId(match2.transaction.hash, match2.logIndex);

    assert.fieldEquals("Fill", base1.concatI32(0).toHexString(), "side", "TAKER");
    assert.fieldEquals("Fill", base1.concatI32(0).toHexString(), "order", takerOid.toHexString());
    assert.fieldEquals("Fill", base1.concatI32(0).toHexString(), "counterpartyOrder", makerAOid.toHexString());
    assert.fieldEquals("Fill", base1.concatI32(1).toHexString(), "side", "MAKER");
    assert.fieldEquals("Fill", base1.concatI32(1).toHexString(), "order", makerAOid.toHexString());
    assert.fieldEquals("Fill", base1.concatI32(1).toHexString(), "counterpartyOrder", takerOid.toHexString());

    assert.fieldEquals("Fill", base2.concatI32(0).toHexString(), "side", "TAKER");
    assert.fieldEquals("Fill", base2.concatI32(0).toHexString(), "order", takerOid.toHexString());
    assert.fieldEquals("Fill", base2.concatI32(0).toHexString(), "counterpartyOrder", makerBOid.toHexString());
    assert.fieldEquals("Fill", base2.concatI32(1).toHexString(), "side", "MAKER");
    assert.fieldEquals("Fill", base2.concatI32(1).toHexString(), "order", makerBOid.toHexString());
    assert.fieldEquals("Fill", base2.concatI32(1).toHexString(), "counterpartyOrder", takerOid.toHexString());
  });

  test("partial fill: averageFillPrice equals fill price; remaining quantity stays in book", () => {
    const maker = userAddress(1);
    const taker = userAddress(2);
    const makerOid = orderId(1);
    const takerOid = orderId(2);
    const price = BigInt.fromI32(3000000);
    const makerQty = BigInt.fromI32(1000000);
    const takerQty = BigInt.fromI32(400000); // only fills part of maker

    handleOrderCreated(createOrderCreatedEvent(makerOid, maker, price, makerQty.neg()));
    handleOrderCreated(createOrderCreatedEvent(takerOid, taker, price, takerQty));

    const match = createOrderMatchedEvent(
      makerOid, maker, taker, price, takerQty,
      takerQty.neg(), takerQty, price, price,
      0,
    );
    handleOrderMatched(match);

    // Maker partially filled (remaining = makerQty - takerQty)
    const makerRemaining = makerQty.minus(takerQty);
    handleOrderUpdated(createOrderUpdatedEvent(makerOid, maker, makerRemaining.neg()));
    // Taker fully filled
    handleOrderUpdated(createOrderUpdatedEvent(takerOid, taker, BigInt.zero()));

    assert.fieldEquals("Order", makerOid.toHexString(), "averageFillPrice", price.toString());
    assert.fieldEquals("Order", makerOid.toHexString(), "filledQuantity", takerQty.toString());
    assert.fieldEquals("Order", makerOid.toHexString(), "status", "PARTIALLY_FILLED");

    assert.fieldEquals("Order", takerOid.toHexString(), "averageFillPrice", price.toString());
    assert.fieldEquals("Order", takerOid.toHexString(), "filledQuantity", takerQty.toString());
    assert.fieldEquals("Order", takerOid.toHexString(), "status", "FILLED");
  });

  test("maker order matched across multiple txs: averageFillPrice is cumulative VWAP", () => {
    const maker = userAddress(1);
    const taker1 = userAddress(2);
    const taker2 = userAddress(3);
    const makerOid = orderId(1);
    const taker1Oid = orderId(2);
    const taker2Oid = orderId(3);
    const makerPrice = BigInt.fromI32(3000000);
    const makerQty = BigInt.fromI32(1000000);

    // Maker rests a sell at 3,000,000 for 1,000,000
    handleOrderCreated(createOrderCreatedEvent(makerOid, maker, makerPrice, makerQty.neg()));

    // tx1: taker1 buys 400,000 at 3,000,000 (price equals maker price; tradePrice = makerPrice)
    handleOrderCreated(createOrderCreatedEvent(taker1Oid, taker1, makerPrice, BigInt.fromI32(400000)));
    const fillQty1 = BigInt.fromI32(400000);
    const match1 = createOrderMatchedEvent(
      makerOid, maker, taker1, makerPrice, fillQty1,
      fillQty1.neg(), fillQty1, makerPrice, makerPrice,
      0,
    );
    handleOrderMatched(match1);
    handleOrderUpdated(createOrderUpdatedEvent(makerOid, maker, makerQty.minus(fillQty1).neg()));
    handleOrderUpdated(createOrderUpdatedEvent(taker1Oid, taker1, BigInt.zero()));

    assert.fieldEquals("Order", makerOid.toHexString(), "averageFillPrice", makerPrice.toString());
    assert.fieldEquals("Order", makerOid.toHexString(), "filledQuantity", fillQty1.toString());

    // tx2: taker2 buys 600,000 — the entire remaining maker order at 3,000,000.
    // Since maker is a limit at 3,000,000 and the cross can only happen at the maker's price,
    // both fills are at the same price → cumulative VWAP stays at makerPrice.
    handleOrderCreated(createOrderCreatedEvent(taker2Oid, taker2, makerPrice, BigInt.fromI32(600000)));
    const fillQty2 = BigInt.fromI32(600000);
    const match2 = createOrderMatchedEvent(
      makerOid, maker, taker2, makerPrice, fillQty2,
      BigInt.zero(), fillQty2, BigInt.zero(), makerPrice,
      0,
    );
    handleOrderMatched(match2);
    handleOrderUpdated(createOrderUpdatedEvent(makerOid, maker, BigInt.zero()));
    handleOrderUpdated(createOrderUpdatedEvent(taker2Oid, taker2, BigInt.zero()));

    assert.fieldEquals("Order", makerOid.toHexString(), "averageFillPrice", makerPrice.toString());
    assert.fieldEquals("Order", makerOid.toHexString(), "filledQuantity", makerQty.toString());
    assert.fieldEquals("Order", makerOid.toHexString(), "status", "FILLED");
  });

  test("self-match: taker and maker are same user, both fills reference correct distinct orders", () => {
    const user = userAddress(1);
    const restingOid = orderId(1);
    const takingOid = orderId(2);
    const price = BigInt.fromI32(3000000);
    const qty = BigInt.fromI32(1000000);

    // Same user puts up an ask, then takes it themselves
    handleOrderCreated(createOrderCreatedEvent(restingOid, user, price, qty.neg()));
    handleOrderCreated(createOrderCreatedEvent(takingOid, user, price, qty));

    // After OrderCreated of takingOid, lastCreatedOrderId should point at takingOid
    assert.fieldEquals("User", user.toHexString(), "lastCreatedOrderId", takingOid.toHexString());

    const match = createOrderMatchedEvent(
      restingOid, user, user, price, qty,
      BigInt.zero(), qty, BigInt.zero(), price,
      0,
    );
    handleOrderMatched(match);
    handleOrderUpdated(createOrderUpdatedEvent(restingOid, user, BigInt.zero()));
    handleOrderUpdated(createOrderUpdatedEvent(takingOid, user, BigInt.zero()));

    // Both orders fully filled at the same price
    assert.fieldEquals("Order", restingOid.toHexString(), "averageFillPrice", price.toString());
    assert.fieldEquals("Order", restingOid.toHexString(), "filledQuantity", qty.toString());
    assert.fieldEquals("Order", takingOid.toHexString(), "averageFillPrice", price.toString());
    assert.fieldEquals("Order", takingOid.toHexString(), "filledQuantity", qty.toString());

    // Critical self-match assertion: user and counterparty are the same address, so `side`,
    // `order`, and `counterpartyOrder` are the only fields that distinguish the two Fill rows.
    const baseId = createEventId(match.transaction.hash, match.logIndex);
    const takerFillId = baseId.concatI32(0).toHexString();
    const makerFillId = baseId.concatI32(1).toHexString();

    assert.fieldEquals("Fill", takerFillId, "side", "TAKER");
    assert.fieldEquals("Fill", takerFillId, "user", user.toHexString());
    assert.fieldEquals("Fill", takerFillId, "counterparty", user.toHexString());
    assert.fieldEquals("Fill", takerFillId, "order", takingOid.toHexString());
    assert.fieldEquals("Fill", takerFillId, "counterpartyOrder", restingOid.toHexString());

    assert.fieldEquals("Fill", makerFillId, "side", "MAKER");
    assert.fieldEquals("Fill", makerFillId, "user", user.toHexString());
    assert.fieldEquals("Fill", makerFillId, "counterparty", user.toHexString());
    assert.fieldEquals("Fill", makerFillId, "order", restingOid.toHexString());
    assert.fieldEquals("Fill", makerFillId, "counterpartyOrder", takingOid.toHexString());
  });

  test("cancelled-after-partial-fill: averageFillPrice and filledQuantity are preserved", () => {
    const maker = userAddress(1);
    const taker = userAddress(2);
    const makerOid = orderId(1);
    const takerOid = orderId(2);
    const price = BigInt.fromI32(3000000);
    const makerQty = BigInt.fromI32(1000000);
    const takerQty = BigInt.fromI32(300000);

    handleOrderCreated(createOrderCreatedEvent(makerOid, maker, price, makerQty.neg()));
    handleOrderCreated(createOrderCreatedEvent(takerOid, taker, price, takerQty));
    const match = createOrderMatchedEvent(
      makerOid, maker, taker, price, takerQty,
      takerQty.neg(), takerQty, price, price,
      0,
    );
    handleOrderMatched(match);
    handleOrderUpdated(createOrderUpdatedEvent(makerOid, maker, makerQty.minus(takerQty).neg()));
    handleOrderUpdated(createOrderUpdatedEvent(takerOid, taker, BigInt.zero()));

    // Maker still has remaining qty; user cancels the rest
    handleOrderCancelled(createOrderCancelledEvent(makerOid, maker));

    // Cancellation must preserve fill history (the partial fill actually happened on-chain)
    assert.fieldEquals("Order", makerOid.toHexString(), "averageFillPrice", price.toString());
    assert.fieldEquals("Order", makerOid.toHexString(), "filledQuantity", takerQty.toString());
    assert.fieldEquals("Order", makerOid.toHexString(), "status", "CANCELLED");
  });

  test("unfilled order: averageFillPrice stays 0", () => {
    const id = orderId(1);
    const address = userAddress(1);
    handleOrderCreated(
      createOrderCreatedEvent(id, address, BigInt.fromI32(3000000), BigInt.fromI32(1000000)),
    );
    assert.fieldEquals("Order", id.toHexString(), "averageFillPrice", "0");
    assert.fieldEquals("Order", id.toHexString(), "filledQuantity", "0");
  });
});
