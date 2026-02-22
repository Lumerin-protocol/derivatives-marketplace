import { describe, test, beforeEach, clearStore } from "matchstick-as/assembly/index";
import { Address, BigInt } from "@graphprotocol/graph-ts";
import { newTypedMockEventWithParams } from "matchstick-as/assembly/defaults";
import { handlePositionTrade } from "../src/perps";
import { PositionTrade } from "../generated/PerpsSimple/PerpsSimple";
import { assert } from "matchstick-as/assembly/index";
import { userAddress, paramAddr, paramUint, paramInt, setupDataSourceMock, mockEventId } from "./helpers";
import { positionSessionId } from "../src/ids";

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

  test("averages exit prices when exiting position", () => {
    const address = userAddress(1);
    const entryPrice = BigInt.fromI32(3000000);
    const oneUnit = BigInt.fromI32(1000000);
    const twoUnits = BigInt.fromI32(2000000);
    const exitPrice1 = BigInt.fromI32(3100000);
    const exitPrice2 = BigInt.fromI32(3300000);
    const pnl1 = BigInt.fromI32(100000);
    const pnl2 = BigInt.fromI32(300000);

    const openEvent = createPositionTradeEvent(
      address,
      entryPrice,
      twoUnits,
      twoUnits,
      entryPrice,
      BigInt.zero(),
    );
    handlePositionTrade(openEvent);

    const partialClose = createPositionTradeEvent(
      address,
      exitPrice1,
      oneUnit.neg(),
      oneUnit,
      entryPrice,
      pnl1,
    );
    handlePositionTrade(partialClose);

    const fullClose = createPositionTradeEvent(
      address,
      exitPrice2,
      oneUnit.neg(),
      BigInt.zero(),
      BigInt.zero(),
      pnl2,
    );
    handlePositionTrade(fullClose);

    const sessionId = positionSessionId(openEvent.block.number, openEvent.logIndex.toI32());
    const expectedAvgExit = exitPrice1.plus(exitPrice2).div(BigInt.fromI32(2));
    const expectedTotalPnl = pnl1.plus(pnl2);
    assert.fieldEquals("PositionSession", sessionId, "closePrice", expectedAvgExit.toString());
    assert.fieldEquals("PositionSession", sessionId, "closedQuantity", twoUnits.toString());
    assert.fieldEquals("PositionSession", sessionId, "realizedPnl", expectedTotalPnl.toString());
    assert.fieldEquals("PositionSession", sessionId, "status", "CLOSE");
  });

  test("it groups trades related to the same position session", () => {
    const address = userAddress(1);
    const entryPrice = BigInt.fromI32(3000000);
    const exitPrice = BigInt.fromI32(3100000);
    const oneUnit = BigInt.fromI32(1000000);
    const twoUnits = BigInt.fromI32(2000000);

    const open = createPositionTradeEvent(
      address, entryPrice, oneUnit, oneUnit, entryPrice, BigInt.zero(),
    );
    open.logIndex = BigInt.fromI32(1);
    handlePositionTrade(open);

    const scaleIn = createPositionTradeEvent(
      address, entryPrice, oneUnit, twoUnits, entryPrice, BigInt.zero(),
    );
    scaleIn.logIndex = BigInt.fromI32(2);
    handlePositionTrade(scaleIn);

    const close = createPositionTradeEvent(
      address, exitPrice, twoUnits.neg(), BigInt.zero(), BigInt.zero(), BigInt.fromI32(200000),
    );
    close.logIndex = BigInt.fromI32(3);
    handlePositionTrade(close);

    const sessionId = positionSessionId(open.block.number, open.logIndex.toI32());

    assert.entityCount("PositionSession", 1);
    assert.entityCount("Trade", 3);
    assert.fieldEquals("Trade", mockEventId(1), "positionSession", sessionId);
    assert.fieldEquals("Trade", mockEventId(2), "positionSession", sessionId);
    assert.fieldEquals("Trade", mockEventId(3), "positionSession", sessionId);
  });
});

function createPositionTradeEvent(
  user: Address,
  tradePrice: BigInt,
  quantity: BigInt,
  netQuantityAfter: BigInt,
  aggregatedEntryPriceAfter: BigInt,
  realizedPnl: BigInt,
  tradingFee: BigInt = BigInt.zero(),
): PositionTrade {
  return newTypedMockEventWithParams<PositionTrade>([
    paramAddr("user", user),
    paramInt("tradePrice", tradePrice),
    paramInt("quantity", quantity),
    paramInt("netQuantityAfter", netQuantityAfter),
    paramUint("aggregatedEntryPriceAfter", aggregatedEntryPriceAfter),
    paramInt("realizedPnl", realizedPnl),
    paramInt("tradingFee", tradingFee),
  ]);
}
