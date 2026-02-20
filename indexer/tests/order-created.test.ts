import { describe, test, beforeEach, clearStore } from "matchstick-as/assembly/index";
import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts";
import { newTypedMockEventWithParams } from "matchstick-as/assembly/defaults";
import { handleOrderCreated } from "../src/perps";
import { OrderCreated } from "../generated/PerpsSimple/PerpsSimple";
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
} from "./helpers";

describe("handleOrderCreated", () => {
  beforeEach(() => {
    clearStore();
    setupDataSourceMock();
  });

  test("creates user, order, price level and updates perps stats for buy order", () => {
    const id = orderId(1);
    const address = userAddress(1);
    const event = createOrderCreatedEvent(id, address, BigInt.fromI32(3000000), BigInt.fromI32(1000000));

    handleOrderCreated(event);

    assert.entityCount("User", 1);
    assert.entityCount("Order", 1);
    assert.entityCount("PriceLevel", 1);
    assert.entityCount("Perps", 1);

    assert.fieldEquals("Order", id.toHexString(), "status", "ACTIVE");
    assert.fieldEquals("Order", id.toHexString(), "isBuy", "true");
    assert.fieldEquals("Order", id.toHexString(), "price", event.params.price.toString());
    assert.fieldEquals("Order", id.toHexString(), "quantity", event.params.quantity.toString());

    assert.fieldEquals(
      "PriceLevel",
      priceLevel(event.params.price, true),
      "totalQuantity",
      event.params.quantity.abs().toString(),
    );
    assert.fieldEquals("PriceLevel", priceLevel(event.params.price, true), "orderCount", "1");

    assert.fieldEquals("Perps", "0", "totalUsers", "1");
    assert.fieldEquals("Perps", "0", "totalOrders", "1");
    assert.fieldEquals("Perps", "0", "activeOrders", "1");

    assert.fieldEquals("User", address.toHexString(), "orderCount", "1");
    assert.fieldEquals("User", address.toHexString(), "activeOrderCount", "1");
  });

  test("creates sell order and ask price level", () => {
    const id = orderId(2);
    const event = createOrderCreatedEvent(id, userAddress(1), BigInt.fromI32(3100000), BigInt.fromI32(-500000));

    handleOrderCreated(event);

    assert.fieldEquals("Order", id.toHexString(), "isBuy", "false");
    assert.fieldEquals("Order", id.toHexString(), "quantity", event.params.quantity.abs().toString());

    assert.fieldEquals(
      "PriceLevel",
      priceLevel(event.params.price, false),
      "totalQuantity",
      event.params.quantity.abs().toString(),
    );
  });
});

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
