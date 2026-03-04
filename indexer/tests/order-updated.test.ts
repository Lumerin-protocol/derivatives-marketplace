import { describe, test, beforeEach, clearStore } from "matchstick-as/assembly/index";
import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts";
import { newTypedMockEventWithParams } from "matchstick-as/assembly/defaults";
import { handleOrderCreated, handleOrderUpdated } from "../src/perps";
import { OrderCreated, OrderUpdated } from "../generated/PerpsSimple/PerpsSimple";
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

describe("handleOrderUpdated", () => {
  beforeEach(() => {
    clearStore();
    setupDataSourceMock();
    setupPerps();
  });

  test("partial fill sets status to PARTIAL and updates quantity", () => {
    const id = orderId(1);
    const address = userAddress(1);
    const price = BigInt.fromI32(3000000);
    const originalQty = BigInt.fromI32(2000000);
    const remainingQty = BigInt.fromI32(1000000);

    handleOrderCreated(createOrderCreatedEvent(id, address, price, originalQty));
    handleOrderUpdated(createOrderUpdatedEvent(id, address, remainingQty));

    assert.fieldEquals("Order", id.toHexString(), "status", "PARTIAL");
    assert.fieldEquals("Order", id.toHexString(), "quantity", remainingQty.toString());
    assert.fieldEquals("Order", id.toHexString(), "filledQuantity", remainingQty.toString());

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

  test("qty=0 sets status to FILLED and decrements price level and active orders", () => {
    const id = orderId(1);
    const address = userAddress(1);
    const price = BigInt.fromI32(3000000);
    const originalQty = BigInt.fromI32(1000000);

    handleOrderCreated(createOrderCreatedEvent(id, address, price, originalQty));

    const updateEvent = createOrderUpdatedEvent(id, address, BigInt.zero());
    handleOrderUpdated(updateEvent);

    assert.fieldEquals("Order", id.toHexString(), "status", "FILLED");
    assert.fieldEquals("Order", id.toHexString(), "quantity", BigInt.zero().toString());
    assert.fieldEquals("Order", id.toHexString(), "filledQuantity", originalQty.toString());
    assert.fieldEquals("Order", id.toHexString(), "closedAt", updateEvent.block.timestamp.toString());
    assert.fieldEquals("Order", id.toHexString(), "updatedAt", updateEvent.block.timestamp.toString());

    assert.fieldEquals(
      "PriceLevel",
      priceLevel(price, true),
      "totalQuantity",
      BigInt.zero().toString(),
    );
    assert.fieldEquals("PriceLevel", priceLevel(price, true), "orderCount", "0");

    assert.fieldEquals("User", address.toHexString(), "activeOrderCount", "0");
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
