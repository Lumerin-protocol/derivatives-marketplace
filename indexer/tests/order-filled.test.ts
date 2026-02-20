import { describe, test, beforeEach, clearStore } from "matchstick-as/assembly/index";
import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts";
import { newTypedMockEventWithParams } from "matchstick-as/assembly/defaults";
import { handleOrderCreated, handleOrderFilled } from "../src/perps";
import { OrderCreated, OrderFilled } from "../generated/PerpsSimple/PerpsSimple";
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

describe("handleOrderFilled", () => {
  beforeEach(() => {
    clearStore();
    setupDataSourceMock();
  });

  test("updates order status to FILLED and decrements price level and active orders", () => {
    const id = orderId(1);
    const address = userAddress(1);
    const createEvent = createOrderCreatedEvent(
      id,
      address,
      BigInt.fromI32(3000000),
      BigInt.fromI32(1000000),
    );
    handleOrderCreated(createEvent);

    const fillEvent = createOrderFilledEvent(id, address);
    handleOrderFilled(fillEvent);

    assert.fieldEquals("Order", id.toHexString(), "status", "FILLED");
    assert.fieldEquals("Order", id.toHexString(), "quantity", BigInt.zero().toString());
    assert.fieldEquals(
      "Order",
      id.toHexString(),
      "filledQuantity",
      createEvent.params.quantity.abs().toString(),
    );

    assert.fieldEquals(
      "PriceLevel",
      priceLevel(createEvent.params.price, true),
      "totalQuantity",
      BigInt.zero().toString(),
    );
    assert.fieldEquals("PriceLevel", priceLevel(createEvent.params.price, true), "orderCount", "0");

    assert.fieldEquals("User", address.toHexString(), "activeOrderCount", "0");
    assert.fieldEquals("Perps", "0", "activeOrders", "0");
  });

  test("does nothing when order not found", () => {
    const fillEvent = createOrderFilledEvent(orderId(999), userAddress(1));
    handleOrderFilled(fillEvent);

    assert.entityCount("Order", 0);
    assert.entityCount("User", 0);
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

function createOrderFilledEvent(orderIdBytes: Bytes, participant: Address): OrderFilled {
  return newTypedMockEventWithParams<OrderFilled>([
    paramBytes("orderId", orderIdBytes),
    paramAddr("participant", participant),
  ]);
}
