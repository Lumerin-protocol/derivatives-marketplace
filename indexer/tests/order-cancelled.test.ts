import { describe, test, beforeEach, clearStore } from "matchstick-as/assembly/index";
import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts";
import { newTypedMockEventWithParams } from "matchstick-as/assembly/defaults";
import { handleOrderCreated, handleOrderCancelled } from "../src/perps";
import { OrderCreated, OrderCancelled } from "../generated/HashPowerPerpsDEX/HashPowerPerpsDEX";
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

function createOrderCancelledEvent(
  orderIdBytes: Bytes,
  participant: Address,
): OrderCancelled {
  return newTypedMockEventWithParams<OrderCancelled>([
    paramBytes("orderId", orderIdBytes),
    paramAddr("participant", participant),
  ]);
}

describe("handleOrderCancelled", () => {
  beforeEach(() => {
    clearStore();
    setupDataSourceMock();
    setupPerps();
  });

  test("cancels active order and updates all related entities", () => {
    const id = orderId(1);
    const address = userAddress(1);
    const price = BigInt.fromI32(3000000);
    const qty = BigInt.fromI32(1000000);

    handleOrderCreated(createOrderCreatedEvent(id, address, price, qty));

    const cancelEvent = createOrderCancelledEvent(id, address);
    handleOrderCancelled(cancelEvent);

    assert.fieldEquals("Order", id.toHexString(), "status", "CANCELLED");
    assert.fieldEquals("Order", id.toHexString(), "closedAt", cancelEvent.block.timestamp.toString());
    assert.fieldEquals("Order", id.toHexString(), "updatedAt", cancelEvent.block.timestamp.toString());

    assert.fieldEquals("PriceLevel", priceLevel(price, true), "totalQuantity", "0");
    assert.fieldEquals("PriceLevel", priceLevel(price, true), "orderCount", "0");

    assert.fieldEquals("User", address.toHexString(), "activeOrderCount", "0");
    assert.fieldEquals("User", address.toHexString(), "lastActivityAt", cancelEvent.block.timestamp.toString());

    assert.fieldEquals("Perps", "0", "activeOrders", "0");
    assert.fieldEquals("Perps", "0", "lastUpdatedAt", cancelEvent.block.timestamp.toString());
  });

  test("does nothing when order not found", () => {
    handleOrderCancelled(createOrderCancelledEvent(orderId(999), userAddress(1)));

    assert.entityCount("Order", 0);
    assert.entityCount("User", 0);
  });

  test("cancelling one of two orders at same price decrements correctly", () => {
    const address = userAddress(1);
    const price = BigInt.fromI32(3000000);
    const qty1 = BigInt.fromI32(1000000);
    const qty2 = BigInt.fromI32(500000);
    const id1 = orderId(1);
    const id2 = orderId(2);

    handleOrderCreated(createOrderCreatedEvent(id1, address, price, qty1));
    handleOrderCreated(createOrderCreatedEvent(id2, address, price, qty2));

    assert.fieldEquals("PriceLevel", priceLevel(price, true), "totalQuantity", qty1.plus(qty2).toString());
    assert.fieldEquals("PriceLevel", priceLevel(price, true), "orderCount", "2");

    handleOrderCancelled(createOrderCancelledEvent(id1, address));

    assert.fieldEquals("Order", id1.toHexString(), "status", "CANCELLED");
    assert.fieldEquals("Order", id2.toHexString(), "status", "ACTIVE");

    assert.fieldEquals("PriceLevel", priceLevel(price, true), "totalQuantity", qty2.toString());
    assert.fieldEquals("PriceLevel", priceLevel(price, true), "orderCount", "1");

    assert.fieldEquals("User", address.toHexString(), "activeOrderCount", "1");
    assert.fieldEquals("User", address.toHexString(), "orderCount", "2");
    assert.fieldEquals("Perps", "0", "activeOrders", "1");
    assert.fieldEquals("Perps", "0", "totalOrders", "2");
  });
});
