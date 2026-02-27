import { describe, test, beforeEach, clearStore } from "matchstick-as/assembly/index";
import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts";
import { newTypedMockEventWithParams } from "matchstick-as/assembly/defaults";
import { handleOrderMatched } from "../src/perps";
import { OrderMatched } from "../generated/PerpsSimple/PerpsSimple";
import { Perps } from "../generated/schema";
import { assert } from "matchstick-as/assembly/index";
import { userAddress, orderId, paramAddr, paramBytes, paramUint, paramInt, setupDataSourceMock } from "./helpers";
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

function createOrderMatchedEvent(
  makerOrderId: Bytes,
  maker: Address,
  taker: Address,
  tradePrice: BigInt,
  takerQuantity: BigInt,
  makerFee: BigInt,
  takerFee: BigInt,
  makerNetQtyAfter: BigInt,
  takerNetQtyAfter: BigInt,
  makerEntryPriceAfter: BigInt,
  takerEntryPriceAfter: BigInt,
): OrderMatched {
  return newTypedMockEventWithParams<OrderMatched>([
    paramBytes("makerOrderId", makerOrderId),
    paramAddr("maker", maker),
    paramAddr("taker", taker),
    paramUint("tradePrice", tradePrice),
    paramInt("takerQuantity", takerQuantity),
    paramInt("makerFee", makerFee),
    paramInt("takerFee", takerFee),
    paramInt("makerNetQtyAfter", makerNetQtyAfter),
    paramInt("takerNetQtyAfter", takerNetQtyAfter),
    paramUint("makerEntryPriceAfter", makerEntryPriceAfter),
    paramUint("takerEntryPriceAfter", takerEntryPriceAfter),
  ]);
}

describe("handleOrderMatched", () => {
  beforeEach(() => {
    clearStore();
    setupDataSourceMock();
    setupPerps();
  });

  test("opens positions and creates fills for buyer and seller", () => {
    const maker = userAddress(1);
    const taker = userAddress(2);
    const price = BigInt.fromI32(3000000);
    const qty = BigInt.fromI32(1000000);

    // Taker buys (+qty), maker sells (-qty)
    const event = createOrderMatchedEvent(
      orderId(1), maker, taker, price,
      qty, BigInt.zero(), BigInt.zero(),
      qty.neg(), qty, price, price,
    );
    handleOrderMatched(event);

    assert.fieldEquals("User", taker.toHexString(), "netQuantity", qty.toString());
    assert.fieldEquals("User", maker.toHexString(), "netQuantity", qty.neg().toString());
    assert.fieldEquals("User", taker.toHexString(), "tradeCount", "1");
    assert.fieldEquals("User", maker.toHexString(), "tradeCount", "1");

    assert.entityCount("Fill", 2);
    assert.entityCount("Trade", 2);
    assert.entityCount("PositionSession", 2);
    assert.fieldEquals("Perps", "0", "totalTrades", "1");
  });

  test("computes realized PnL when closing a long position", () => {
    const maker1 = userAddress(1);
    const trader = userAddress(2);
    const maker2 = userAddress(3);
    const entryPrice = BigInt.fromI32(3000000);
    const exitPrice = BigInt.fromI32(3100000);
    const qty = BigInt.fromI32(1000000);

    // Open: trader (taker) buys +qty at entryPrice
    const openEvent = createOrderMatchedEvent(
      orderId(1), maker1, trader, entryPrice,
      qty, BigInt.zero(), BigInt.zero(),
      qty.neg(), qty, entryPrice, entryPrice,
    );
    openEvent.logIndex = BigInt.fromI32(1);
    openEvent.transaction.hash = orderId(100);
    handleOrderMatched(openEvent);

    assert.fieldEquals("User", trader.toHexString(), "netQuantity", qty.toString());

    // Close: trader (taker) sells -qty at exitPrice
    const closeEvent = createOrderMatchedEvent(
      orderId(2), maker2, trader, exitPrice,
      qty.neg(), BigInt.zero(), BigInt.zero(),
      qty, BigInt.zero(), exitPrice, BigInt.zero(),
    );
    closeEvent.logIndex = BigInt.fromI32(2);
    closeEvent.transaction.hash = orderId(101);
    handleOrderMatched(closeEvent);

    // PnL = (3100000 - 3000000) * 1000000 / 1000000 = 100000
    assert.fieldEquals("User", trader.toHexString(), "netQuantity", "0");
    assert.fieldEquals("User", trader.toHexString(), "realizedPnl", "100000");
  });

  test("uses entry price from event on scale-in", () => {
    const maker1 = userAddress(1);
    const maker2 = userAddress(2);
    const taker = userAddress(3);
    const price1 = BigInt.fromI32(3000000);
    const price2 = BigInt.fromI32(3200000);
    const avgPrice = BigInt.fromI32(3100000);
    const qty = BigInt.fromI32(1000000);

    // First fill: taker buys 1 unit at 3000000
    const event1 = createOrderMatchedEvent(
      orderId(1), maker1, taker, price1,
      qty, BigInt.zero(), BigInt.zero(),
      qty.neg(), qty, price1, price1,
    );
    event1.logIndex = BigInt.fromI32(1);
    event1.transaction.hash = orderId(100);
    handleOrderMatched(event1);

    // Second fill: taker buys 1 unit at 3200000, avg entry = 3100000
    const event2 = createOrderMatchedEvent(
      orderId(2), maker2, taker, price2,
      qty, BigInt.zero(), BigInt.zero(),
      qty.neg(), qty.plus(qty), price2, avgPrice,
    );
    event2.logIndex = BigInt.fromI32(2);
    event2.transaction.hash = orderId(101);
    handleOrderMatched(event2);

    assert.fieldEquals("User", taker.toHexString(), "netQuantity", qty.plus(qty).toString());
    assert.fieldEquals("User", taker.toHexString(), "aggregatedEntryPrice", "3100000");
  });

  test("aggregates multiple fills into one trade per user per tx", () => {
    const maker1 = userAddress(1);
    const maker2 = userAddress(2);
    const taker = userAddress(3);
    const price = BigInt.fromI32(3000000);
    const qty1 = BigInt.fromI32(500000);
    const qty2 = BigInt.fromI32(300000);
    const txHash = orderId(100);

    const event1 = createOrderMatchedEvent(
      orderId(1), maker1, taker, price,
      qty1, BigInt.zero(), BigInt.zero(),
      qty1.neg(), qty1, price, price,
    );
    event1.logIndex = BigInt.fromI32(1);
    event1.transaction.hash = txHash;
    handleOrderMatched(event1);

    const event2 = createOrderMatchedEvent(
      orderId(2), maker2, taker, price,
      qty2, BigInt.zero(), BigInt.zero(),
      qty2.neg(), qty1.plus(qty2), price, price,
    );
    event2.logIndex = BigInt.fromI32(2);
    event2.transaction.hash = txHash;
    handleOrderMatched(event2);

    assert.entityCount("Fill", 4);
    const takerTradeId = txHash.concat(taker).toHexString();
    assert.fieldEquals("Trade", takerTradeId, "fillCount", "2");
    assert.fieldEquals("Trade", takerTradeId, "totalQuantity", qty1.plus(qty2).toString());
    assert.fieldEquals("Trade", takerTradeId, "averagePrice", price.toString());
  });

  test("closes position session on full close", () => {
    const maker1 = userAddress(1);
    const trader = userAddress(2);
    const maker2 = userAddress(3);
    const entryPrice = BigInt.fromI32(3000000);
    const exitPrice = BigInt.fromI32(3100000);
    const qty = BigInt.fromI32(1000000);

    const openEvent = createOrderMatchedEvent(
      orderId(1), maker1, trader, entryPrice,
      qty, BigInt.zero(), BigInt.zero(),
      qty.neg(), qty, entryPrice, entryPrice,
    );
    openEvent.logIndex = BigInt.fromI32(1);
    openEvent.transaction.hash = orderId(100);
    handleOrderMatched(openEvent);

    // Taker is sideIndex=0, session ID uses logIndex*2+0
    const sessionId = positionSessionId(openEvent.block.number, openEvent.logIndex.toI32() * 2);
    assert.fieldEquals("PositionSession", sessionId, "status", "OPEN");
    assert.fieldEquals("PositionSession", sessionId, "entryPrice", entryPrice.toString());

    const closeEvent = createOrderMatchedEvent(
      orderId(2), maker2, trader, exitPrice,
      qty.neg(), BigInt.zero(), BigInt.zero(),
      qty, BigInt.zero(), exitPrice, BigInt.zero(),
    );
    closeEvent.logIndex = BigInt.fromI32(2);
    closeEvent.transaction.hash = orderId(101);
    handleOrderMatched(closeEvent);

    assert.fieldEquals("PositionSession", sessionId, "status", "CLOSE");
    assert.fieldEquals("PositionSession", sessionId, "realizedPnl", "100000");
    assert.fieldEquals("PositionSession", sessionId, "closedQuantity", qty.toString());
  });
});
