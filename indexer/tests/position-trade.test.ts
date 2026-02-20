import { describe, test, beforeEach, clearStore } from "matchstick-as/assembly/index";
import { Address, BigInt } from "@graphprotocol/graph-ts";
import { newTypedMockEventWithParams } from "matchstick-as/assembly/defaults";
import { handlePositionTrade } from "../src/perps";
import { PositionTrade } from "../generated/PerpsSimple/PerpsSimple";
import { assert } from "matchstick-as/assembly/index";
import { userAddress, paramAddr, paramUint, paramInt, setupDataSourceMock } from "./helpers";

describe("handlePositionTrade", () => {
  beforeEach(() => {
    clearStore();
    setupDataSourceMock();
  });

  test("opens new position session when going from flat to long", () => {
    const address = userAddress(1);
    const event = createPositionTradeEvent(
      address,
      BigInt.fromI32(3000000),
      BigInt.fromI32(1000000),
      BigInt.fromI32(1000000),
      BigInt.fromI32(3000000),
      BigInt.zero(),
    );

    handlePositionTrade(event);

    assert.entityCount("User", 1);
    assert.entityCount("PositionSession", 1);
    assert.entityCount("Trade", 1);

    assert.fieldEquals(
      "User",
      address.toHexString(),
      "netQuantity",
      event.params.netQuantityAfter.toString(),
    );
    assert.fieldEquals("User", address.toHexString(), "tradeCount", "1");

    assert.entityCount("PositionSession", 1);
  });

  test("adds realized PnL when closing position", () => {
    const address = userAddress(1);
    const tradeEvent = createPositionTradeEvent(
      address,
      BigInt.fromI32(3000000),
      BigInt.fromI32(1000000),
      BigInt.fromI32(1000000),
      BigInt.fromI32(3000000),
      BigInt.zero(),
    );
    handlePositionTrade(tradeEvent);

    const closeEvent = createPositionTradeEvent(
      address,
      BigInt.fromI32(3100000),
      BigInt.fromI32(-1000000),
      BigInt.zero(),
      BigInt.fromI32(3000000),
      BigInt.fromI32(50000),
    );
    handlePositionTrade(closeEvent);

    assert.fieldEquals(
      "User",
      address.toHexString(),
      "realizedPnl",
      closeEvent.params.realizedPnl.toString(),
    );
    assert.fieldEquals(
      "User",
      address.toHexString(),
      "netQuantity",
      closeEvent.params.netQuantityAfter.toString(),
    );
  });
});

function createPositionTradeEvent(
  user: Address,
  tradePrice: BigInt,
  quantity: BigInt,
  netQuantityAfter: BigInt,
  aggregatedEntryPriceAfter: BigInt,
  realizedPnl: BigInt,
): PositionTrade {
  return newTypedMockEventWithParams<PositionTrade>([
    paramAddr("user", user),
    paramInt("tradePrice", tradePrice),
    paramInt("quantity", quantity),
    paramInt("netQuantityAfter", netQuantityAfter),
    paramUint("aggregatedEntryPriceAfter", aggregatedEntryPriceAfter),
    paramInt("realizedPnl", realizedPnl),
  ]);
}
