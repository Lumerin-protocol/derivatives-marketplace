import { describe, test, beforeEach, clearStore } from "matchstick-as/assembly/index";
import { Address, BigInt } from "@graphprotocol/graph-ts";
import { newTypedMockEventWithParams } from "matchstick-as/assembly/defaults";
import { handleFundingSettled, handlePositionTrade } from "../src/perps";
import { FundingSettled, PositionTrade } from "../generated/PerpsSimple/PerpsSimple";
import { assert } from "matchstick-as/assembly/index";
import { userAddress, paramAddr, paramUint, paramInt, setupDataSourceMock, mockEventId } from "./helpers";
import { positionSessionId } from "../src/ids";

describe("handleFundingSettled", () => {
  beforeEach(() => {
    clearStore();
    setupDataSourceMock();
  });

  test("links settlement to open position session and accumulates fundingFees", () => {
    const address = userAddress(1);
    const entryPrice = BigInt.fromI32(3000000);
    const oneUnit = BigInt.fromI32(1000000);
    const fundingPaid = BigInt.fromI32(-50000);
    const fundingReceived = BigInt.fromI32(30000);

    const open = createPositionTradeEvent(address, entryPrice, oneUnit, oneUnit, entryPrice, BigInt.zero());
    handlePositionTrade(open);

    const sessionId = positionSessionId(open.block.number, open.logIndex.toI32());

    const settle1 = createFundingSettledEvent(address, fundingPaid, 2);
    handleFundingSettled(settle1);

    const settle2 = createFundingSettledEvent(address, fundingReceived, 3);
    handleFundingSettled(settle2);

    const expectedFees = fundingPaid.plus(fundingReceived);
    assert.fieldEquals("PositionSession", sessionId, "fundingFees", expectedFees.toString());

    assert.entityCount("FundingSettlement", 2);
    assert.fieldEquals("FundingSettlement", mockEventId(2), "positionSession", sessionId);
    assert.fieldEquals("FundingSettlement", mockEventId(3), "positionSession", sessionId);
  });

  test("funding settled before close is linked to the session being closed", () => {
    const address = userAddress(1);
    const entryPrice = BigInt.fromI32(3000000);
    const exitPrice = BigInt.fromI32(3100000);
    const oneUnit = BigInt.fromI32(1000000);
    const fundingAmount = BigInt.fromI32(-40000);
    const pnl = BigInt.fromI32(100000);

    const open = createPositionTradeEvent(address, entryPrice, oneUnit, oneUnit, entryPrice, BigInt.zero());
    open.logIndex = BigInt.fromI32(1);
    handlePositionTrade(open);

    const sessionId = positionSessionId(open.block.number, open.logIndex.toI32());

    const settle = createFundingSettledEvent(address, fundingAmount, 2);
    handleFundingSettled(settle);

    const close = createPositionTradeEvent(address, exitPrice, oneUnit.neg(), BigInt.zero(), BigInt.zero(), pnl);
    close.logIndex = BigInt.fromI32(3);
    handlePositionTrade(close);

    assert.fieldEquals("PositionSession", sessionId, "status", "CLOSE");
    assert.fieldEquals("PositionSession", sessionId, "fundingFees", fundingAmount.toString());
    assert.fieldEquals("FundingSettlement", mockEventId(2), "positionSession", sessionId);
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

function createFundingSettledEvent(
  user: Address,
  amount: BigInt,
  logIndex: i32 = 1,
): FundingSettled {
  const event = newTypedMockEventWithParams<FundingSettled>([
    paramAddr("user", user),
    paramInt("amount", amount),
  ]);
  event.logIndex = BigInt.fromI32(logIndex);
  return event;
}
