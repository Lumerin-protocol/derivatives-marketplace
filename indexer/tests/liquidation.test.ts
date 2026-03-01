import { describe, test, beforeEach, clearStore } from "matchstick-as/assembly/index";
import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts";
import { newTypedMockEventWithParams } from "matchstick-as/assembly/defaults";
import { handleOrderMatched, handlePositionLiquidated } from "../src/perps";
import { OrderMatched, PositionLiquidated } from "../generated/PerpsSimple/PerpsSimple";
import { Perps } from "../generated/schema";
import { assert } from "matchstick-as/assembly/index";
import {
  userAddress,
  orderId,
  paramAddr,
  paramBytes,
  paramUint,
  paramInt,
  mockEventId,
  setupDataSourceMock,
} from "./helpers";
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

function createPositionLiquidatedEvent(
  user: Address,
  liquidator: Address,
  positionSize: BigInt,
  pnl: BigInt,
  liquidatorFee: BigInt,
  logIndex: i32 = 1,
): PositionLiquidated {
  const event = newTypedMockEventWithParams<PositionLiquidated>([
    paramAddr("user", user),
    paramAddr("liquidator", liquidator),
    paramInt("positionSize", positionSize),
    paramInt("pnl", pnl),
    paramUint("liquidatorFee", liquidatorFee),
  ]);
  event.logIndex = BigInt.fromI32(logIndex);
  return event;
}

describe("handlePositionLiquidated", () => {
  beforeEach(() => {
    clearStore();
    setupDataSourceMock();
    setupPerps();
  });

  test("liquidates open long and asserts all fields", () => {
    const trader = userAddress(1);
    const maker = userAddress(2);
    const liquidator = userAddress(3);
    const entryPrice = BigInt.fromI32(3000000);
    const qty = BigInt.fromI32(1000000);
    const pnl = BigInt.fromI32(-200000);
    const liqFee = BigInt.fromI32(10000);

    openLongPosition(trader, maker, entryPrice, qty, orderId(1), orderId(100), 1);

    const sessionId = positionSessionId(BigInt.fromI32(1), 1 * 2);
    assert.fieldEquals("PositionSession", sessionId, "status", "OPEN");

    const liqEvent = createPositionLiquidatedEvent(trader, liquidator, qty, pnl, liqFee);
    handlePositionLiquidated(liqEvent);

    const liqId = mockEventId(1);

    // Liquidation entity - all fields
    assert.entityCount("Liquidation", 1);
    assert.fieldEquals("Liquidation", liqId, "user", trader.toHexString());
    assert.fieldEquals("Liquidation", liqId, "liquidator", liquidator.toHexString());
    assert.fieldEquals("Liquidation", liqId, "positionSize", qty.toString());
    assert.fieldEquals("Liquidation", liqId, "pnl", pnl.toString());
    assert.fieldEquals("Liquidation", liqId, "liquidatorFee", liqFee.toString());
    assert.fieldEquals("Liquidation", liqId, "timestamp", liqEvent.block.timestamp.toString());
    assert.fieldEquals("Liquidation", liqId, "blockNumber", liqEvent.block.number.toString());
    assert.fieldEquals(
      "Liquidation",
      liqId,
      "transactionHash",
      liqEvent.transaction.hash.toHexString(),
    );

    // User reset
    assert.fieldEquals("User", trader.toHexString(), "netQuantity", "0");
    assert.fieldEquals("User", trader.toHexString(), "aggregatedEntryPrice", "0");
    assert.fieldEquals("User", trader.toHexString(), "currentPositionSessionId", "");
    assert.fieldEquals("User", trader.toHexString(), "realizedPnl", pnl.toString());
    assert.fieldEquals(
      "User",
      trader.toHexString(),
      "lastActivityAt",
      liqEvent.block.timestamp.toString(),
    );

    // Liquidator
    assert.fieldEquals(
      "User",
      liquidator.toHexString(),
      "lastActivityAt",
      liqEvent.block.timestamp.toString(),
    );

    // PositionSession closed
    assert.fieldEquals("PositionSession", sessionId, "status", "CLOSE");
    assert.fieldEquals(
      "PositionSession",
      sessionId,
      "lastTradeAt",
      liqEvent.block.timestamp.toString(),
    );

    // Perps stats
    assert.fieldEquals("Perps", "0", "totalLiquidations", "1");
    assert.fieldEquals("Perps", "0", "lastUpdatedAt", liqEvent.block.timestamp.toString());
  });
});
