import { describe, test, beforeEach, clearStore } from "matchstick-as/assembly/index";
import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts";
import { newTypedMockEventWithParams } from "matchstick-as/assembly/defaults";
import { handleOrderMatched } from "../src/perps";
import { OrderMatched } from "../generated/PerpsSimple/PerpsSimple";
import { assert } from "matchstick-as/assembly/index";
import {
  userAddress,
  orderId,
  paramAddr,
  paramBytes,
  paramUint,
  setupDataSourceMock,
} from "./helpers";

function createOrderMatchedEvent(
  makerOrderId: Bytes,
  buyer: Address,
  seller: Address,
  price: BigInt,
  quantity: BigInt,
): OrderMatched {
  return newTypedMockEventWithParams<OrderMatched>([
    paramBytes("makerOrderId", makerOrderId),
    paramAddr("buyer", buyer),
    paramAddr("seller", seller),
    paramUint("price", price),
    paramUint("quantity", quantity),
  ]);
}

describe("handleOrderMatched", () => {
  beforeEach(() => {
    clearStore();
    setupDataSourceMock();
  });

  test("creates buyer and seller users and updates perps volume", () => {
    const event = createOrderMatchedEvent(
      orderId(1),
      userAddress(1),
      userAddress(2),
      BigInt.fromI32(3000000),
      BigInt.fromI32(1000000),
    );

    handleOrderMatched(event);

    assert.entityCount("User", 2);
    assert.entityCount("Perps", 1);

    const volume = event.params.price.times(event.params.quantity);
    assert.fieldEquals("Perps", "0", "totalTrades", "1");
    assert.fieldEquals("Perps", "0", "totalVolume", volume.toString());
  });
});
