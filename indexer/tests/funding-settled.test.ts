import { describe, test, beforeEach, clearStore } from "matchstick-as/assembly/index";
import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts";
import { newTypedMockEventWithParams } from "matchstick-as/assembly/defaults";
import { handleFundingSettled, handleOrderMatched } from "../src/perps";
import { FundingSettled, OrderMatched } from "../generated/PerpsSimple/PerpsSimple";
import { Perps } from "../generated/schema";
import { assert } from "matchstick-as/assembly/index";
import { userAddress, orderId, paramAddr, paramBytes, paramUint, paramInt, setupDataSourceMock, mockEventId } from "./helpers";
import { positionSessionId } from "../src/ids";

function setupPerps(): void {
  const perps = new Perps(0);
  perps.contractAddress = Bytes.empty();
  perps.collateralToken = Bytes.empty();
  perps.priceOracle = Bytes.empty();
  perps.quantityDecimals = 6;
  perps.minimumPriceIncrement = BigInt.zero();
  perps.marginPercent = 0;
  perps.maintenanceMarginPercent = 0;
  perps.liquidationFee = BigInt.zero();
  perps.takerFeeBps = 0;
  perps.makerFeeBps = 0;
  perps.fundingRateMaxBps = BigInt.zero();
  perps.fundingPeriod = BigInt.zero();
  perps.cumulativeFundingPerUnit = BigInt.zero();
  perps.lastFundingUpdateTime = BigInt.zero();
  perps.minimumMarginPerOrder = BigInt.zero();
  perps.reservePoolBalance = BigInt.zero();
  perps.collectedFeesBalance = BigInt.zero();
  perps.totalUsers = 0;
  perps.totalOrders = 0;
  perps.activeOrders = 0;
  perps.totalTrades = 0;
  perps.totalVolume = BigInt.zero();
  perps.totalLiquidations = 0;
  perps.totalBadDebt = BigInt.zero();
  perps.initializedAt = BigInt.zero();
  perps.lastUpdatedAt = BigInt.zero();
  perps.save();
}

/** Open a long position for `trader` (taker buys +qty). */
function openLongPosition(
  trader: Address,
  maker: Address,
  price: BigInt,
  qty: BigInt,
  oid: Bytes,
  txHash: Bytes,
  logIndex: i32,
): void {
  const zero = BigInt.zero();
  const event = newTypedMockEventWithParams<OrderMatched>([
    paramBytes("makerOrderId", oid),
    paramAddr("maker", maker),
    paramAddr("taker", trader),
    paramUint("tradePrice", price),
    paramInt("takerQuantity", qty),
    paramInt("makerFee", zero),
    paramInt("takerFee", zero),
    paramInt("makerNetQtyAfter", qty.neg()),
    paramInt("takerNetQtyAfter", qty),
    paramUint("makerEntryPriceAfter", price),
    paramUint("takerEntryPriceAfter", price),
  ]);
  event.logIndex = BigInt.fromI32(logIndex);
  event.transaction.hash = txHash;
  handleOrderMatched(event);
}

/** Close trader's long (taker sells -qty). */
function closeLongPosition(
  trader: Address,
  maker: Address,
  price: BigInt,
  qty: BigInt,
  oid: Bytes,
  txHash: Bytes,
  logIndex: i32,
): void {
  const zero = BigInt.zero();
  const event = newTypedMockEventWithParams<OrderMatched>([
    paramBytes("makerOrderId", oid),
    paramAddr("maker", maker),
    paramAddr("taker", trader),
    paramUint("tradePrice", price),
    paramInt("takerQuantity", qty.neg()),
    paramInt("makerFee", zero),
    paramInt("takerFee", zero),
    paramInt("makerNetQtyAfter", qty),
    paramInt("takerNetQtyAfter", zero),
    paramUint("makerEntryPriceAfter", price),
    paramUint("takerEntryPriceAfter", zero),
  ]);
  event.logIndex = BigInt.fromI32(logIndex);
  event.transaction.hash = txHash;
  handleOrderMatched(event);
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

describe("handleFundingSettled", () => {
  beforeEach(() => {
    clearStore();
    setupDataSourceMock();
    setupPerps();
  });

  test("links settlement to open position session and accumulates fundingFees", () => {
    const trader = userAddress(1);
    const maker = userAddress(2);
    const entryPrice = BigInt.fromI32(3000000);
    const oneUnit = BigInt.fromI32(1000000);
    const fundingPaid = BigInt.fromI32(-50000);
    const fundingReceived = BigInt.fromI32(30000);

    openLongPosition(trader, maker, entryPrice, oneUnit, orderId(1), orderId(100), 1);

    // Trader is buyer (sideIndex=0), session uses logIndex*2+0
    const sessionId = positionSessionId(BigInt.fromI32(1), 1 * 2);

    const settle1 = createFundingSettledEvent(trader, fundingPaid, 2);
    handleFundingSettled(settle1);

    const settle2 = createFundingSettledEvent(trader, fundingReceived, 3);
    handleFundingSettled(settle2);

    const expectedFees = fundingPaid.plus(fundingReceived);
    assert.fieldEquals("PositionSession", sessionId, "fundingFees", expectedFees.toString());

    assert.entityCount("FundingSettlement", 2);
    assert.fieldEquals("FundingSettlement", mockEventId(2), "positionSession", sessionId);
    assert.fieldEquals("FundingSettlement", mockEventId(3), "positionSession", sessionId);
  });

  test("funding settled before close is linked to the session being closed", () => {
    const trader = userAddress(1);
    const openMaker = userAddress(2);
    const closeMaker = userAddress(3);
    const entryPrice = BigInt.fromI32(3000000);
    const exitPrice = BigInt.fromI32(3100000);
    const oneUnit = BigInt.fromI32(1000000);
    const fundingAmount = BigInt.fromI32(-40000);

    openLongPosition(trader, openMaker, entryPrice, oneUnit, orderId(1), orderId(100), 1);
    const sessionId = positionSessionId(BigInt.fromI32(1), 1 * 2);

    const settle = createFundingSettledEvent(trader, fundingAmount, 2);
    handleFundingSettled(settle);

    closeLongPosition(trader, closeMaker, exitPrice, oneUnit, orderId(2), orderId(101), 3);

    assert.fieldEquals("PositionSession", sessionId, "status", "CLOSE");
    assert.fieldEquals("PositionSession", sessionId, "fundingFees", fundingAmount.toString());
    assert.fieldEquals("FundingSettlement", mockEventId(2), "positionSession", sessionId);
  });
});
