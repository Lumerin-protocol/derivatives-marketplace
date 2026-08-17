import { describe, test, beforeEach, clearStore } from "matchstick-as/assembly/index";
import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts";
import { newTypedMockEventWithParams } from "matchstick-as/assembly/defaults";
import { handleOrderCreated, handleOrderMatched, handleOrderUpdated } from "../src/perps";
import {
  OrderCreated,
  OrderMatched,
  OrderUpdated,
} from "../generated/HashPowerPerpsDEX/HashPowerPerpsDEX";
import { assert } from "matchstick-as/assembly/index";
import {
  userAddress,
  orderId,
  paramAddr,
  paramBytes,
  paramUint,
  paramInt,
  priceLevel,
  setupDataSourceMock,
  setupPerps,
} from "./helpers";

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

function createOrderMatchedEvent(
  makerOrderId: Bytes,
  maker: Address,
  taker: Address,
  tradePrice: BigInt,
  takerQuantity: BigInt,
): OrderMatched {
  return newTypedMockEventWithParams<OrderMatched>([
    paramBytes("makerOrderId", makerOrderId),
    paramAddr("maker", maker),
    paramAddr("taker", taker),
    paramUint("tradePrice", tradePrice),
    paramInt("takerQuantity", takerQuantity),
    paramInt("makerFee", BigInt.zero()),
    paramInt("takerFee", BigInt.zero()),
    paramInt("makerNetQtyAfter", BigInt.zero()),
    paramInt("takerNetQtyAfter", takerQuantity),
    paramUint("makerEntryPriceAfter", tradePrice),
    paramUint("takerEntryPriceAfter", tradePrice),
  ]);
}

describe("handleOrderUpdated", () => {
  beforeEach(() => {
    clearStore();
    setupDataSourceMock();
    setupPerps();
  });

  test("reduce-only amend keeps ACTIVE and does not invent fills", () => {
    const id = orderId(1);
    const address = userAddress(1);
    const price = BigInt.fromI32(3000000);
    const originalQty = BigInt.fromI32(2000000);
    const remainingQty = BigInt.fromI32(1000000);

    handleOrderCreated(createOrderCreatedEvent(id, address, price, originalQty));
    handleOrderUpdated(createOrderUpdatedEvent(id, address, remainingQty));

    assert.fieldEquals("Order", id.toHexString(), "status", "ACTIVE");
    assert.fieldEquals("Order", id.toHexString(), "quantity", remainingQty.toString());
    assert.fieldEquals("Order", id.toHexString(), "filledQuantity", "0");
    // The shrink did not match, so it lands in cancelledQuantity.
    assert.fieldEquals(
      "Order",
      id.toHexString(),
      "cancelledQuantity",
      originalQty.minus(remainingQty).toString(),
    );

    assert.fieldEquals(
      "PriceLevel",
      priceLevel(price, true),
      "totalQuantity",
      remainingQty.toString(),
    );
    assert.fieldEquals("PriceLevel", priceLevel(price, true), "orderCount", "1");
    assert.fieldEquals("User", address.toHexString(), "activeOrderCount", "1");
    assert.fieldEquals("Perps", "0", "activeOrders", "1");
  });

  test("partial fill via OrderMatched then OrderUpdated sets PARTIALLY_FILLED", () => {
    const id = orderId(1);
    const maker = userAddress(1);
    const taker = userAddress(2);
    const price = BigInt.fromI32(3000000);
    const originalQty = BigInt.fromI32(2000000);
    const fillQty = BigInt.fromI32(1000000);
    const remainingQty = BigInt.fromI32(1000000);

    handleOrderCreated(createOrderCreatedEvent(id, maker, price, originalQty));
    // On-chain perps emits Match before maker OrderUpdated.
    handleOrderMatched(createOrderMatchedEvent(id, maker, taker, price, fillQty.neg()));
    handleOrderUpdated(createOrderUpdatedEvent(id, maker, remainingQty));

    assert.fieldEquals("Order", id.toHexString(), "status", "PARTIALLY_FILLED");
    assert.fieldEquals("Order", id.toHexString(), "quantity", remainingQty.toString());
    assert.fieldEquals("Order", id.toHexString(), "filledQuantity", fillQty.toString());
    // Everything that left the book matched, so nothing is cancelled.
    assert.fieldEquals("Order", id.toHexString(), "cancelledQuantity", "0");
  });

  test("qty=0 after fills sets status to FILLED", () => {
    const id = orderId(1);
    const maker = userAddress(1);
    const taker = userAddress(2);
    const price = BigInt.fromI32(3000000);
    const originalQty = BigInt.fromI32(1000000);

    handleOrderCreated(createOrderCreatedEvent(id, maker, price, originalQty));
    handleOrderMatched(createOrderMatchedEvent(id, maker, taker, price, originalQty.neg()));
    const updateEvent = createOrderUpdatedEvent(id, maker, BigInt.zero());
    handleOrderUpdated(updateEvent);

    assert.fieldEquals("Order", id.toHexString(), "status", "FILLED");
    assert.fieldEquals("Order", id.toHexString(), "quantity", BigInt.zero().toString());
    assert.fieldEquals("Order", id.toHexString(), "filledQuantity", originalQty.toString());
    assert.fieldEquals("Order", id.toHexString(), "cancelledQuantity", "0");
    assert.fieldEquals("Order", id.toHexString(), "closedAt", updateEvent.block.timestamp.toString());
    assert.fieldEquals(
      "Order",
      id.toHexString(),
      "closedByTx",
      updateEvent.transaction.from.toHexString(),
    );

    assert.fieldEquals(
      "PriceLevel",
      priceLevel(price, true),
      "totalQuantity",
      BigInt.zero().toString(),
    );
    assert.fieldEquals("PriceLevel", priceLevel(price, true), "orderCount", "0");
    assert.fieldEquals("User", maker.toHexString(), "activeOrderCount", "0");
    assert.fieldEquals("Perps", "0", "activeOrders", "0");
  });

  test("does nothing when order not found", () => {
    handleOrderUpdated(
      createOrderUpdatedEvent(orderId(999), userAddress(1), BigInt.zero()),
    );

    assert.entityCount("Order", 0);
    assert.entityCount("User", 0);
  });
});
