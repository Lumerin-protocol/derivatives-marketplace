import { describe, test, beforeEach, clearStore } from "matchstick-as/assembly/index";
import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts";
import { newTypedMockEventWithParams } from "matchstick-as/assembly/defaults";
import { handleOrderMatched } from "../src/perps";
import { OrderMatched } from "../generated/PerpsSimple/PerpsSimple";
import { Perps } from "../generated/schema";
import { assert } from "matchstick-as/assembly/index";
import { userAddress, orderId, paramAddr, paramBytes, paramUint, paramInt, setupDataSourceMock } from "./helpers";
import { positionSessionId, createEventId } from "../src/ids";

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
    const mOid = orderId(1);

    // Taker buys (+qty), maker sells (-qty)
    const event = createOrderMatchedEvent(
      mOid, maker, taker, price,
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

    // volume = price * absQty / quantityScale = 3000000 * 1000000 / 1000000 = 3000000
    assert.fieldEquals("Perps", "0", "totalVolume", "3000000");

    // Fill IDs: createEventId(txHash, logIndex).concatI32(sideIndex)
    const baseId = createEventId(event.transaction.hash, event.logIndex);
    const takerFillId = baseId.concatI32(0).toHexString();
    const makerFillId = baseId.concatI32(1).toHexString();

    // Taker fill (buyer, +qty)
    assert.fieldEquals("Fill", takerFillId, "fillPrice", price.toString());
    assert.fieldEquals("Fill", takerFillId, "fillQuantity", qty.toString());
    assert.fieldEquals("Fill", takerFillId, "netQuantityAfter", qty.toString());
    assert.fieldEquals("Fill", takerFillId, "aggregatedEntryPriceAfter", price.toString());
    assert.fieldEquals("Fill", takerFillId, "realizedPnl", "0");
    assert.fieldEquals("Fill", takerFillId, "tradingFee", "0");
    assert.fieldEquals("Fill", takerFillId, "user", taker.toHexString());
    assert.fieldEquals("Fill", takerFillId, "counterparty", maker.toHexString());
    assert.fieldEquals("Fill", takerFillId, "makerOrderId", mOid.toHexString());
    assert.fieldEquals("Fill", takerFillId, "timestamp", event.block.timestamp.toString());
    assert.fieldEquals("Fill", takerFillId, "blockNumber", event.block.number.toString());
    assert.fieldEquals("Fill", takerFillId, "transactionHash", event.transaction.hash.toHexString());

    // Maker fill (seller, -qty)
    assert.fieldEquals("Fill", makerFillId, "fillPrice", price.toString());
    assert.fieldEquals("Fill", makerFillId, "fillQuantity", qty.neg().toString());
    assert.fieldEquals("Fill", makerFillId, "netQuantityAfter", qty.neg().toString());
    assert.fieldEquals("Fill", makerFillId, "aggregatedEntryPriceAfter", price.toString());
    assert.fieldEquals("Fill", makerFillId, "realizedPnl", "0");
    assert.fieldEquals("Fill", makerFillId, "tradingFee", "0");
    assert.fieldEquals("Fill", makerFillId, "user", maker.toHexString());
    assert.fieldEquals("Fill", makerFillId, "counterparty", taker.toHexString());
    assert.fieldEquals("Fill", makerFillId, "makerOrderId", mOid.toHexString());

    // Session IDs
    const takerSessionId = positionSessionId(event.block.number, event.logIndex.toI32() * 2);
    const makerSessionId = positionSessionId(event.block.number, event.logIndex.toI32() * 2 + 1);

    // Trade assertions (taker)
    const takerTradeId = event.transaction.hash.concat(taker).toHexString();
    assert.fieldEquals("Trade", takerTradeId, "user", taker.toHexString());
    assert.fieldEquals("Trade", takerTradeId, "positionSession", takerSessionId);
    assert.fieldEquals("Trade", takerTradeId, "tradePrice", price.toString());
    assert.fieldEquals("Trade", takerTradeId, "tradeQuantity", qty.toString());
    assert.fieldEquals("Trade", takerTradeId, "tradingFee", "0");
    assert.fieldEquals("Trade", takerTradeId, "realizedPnl", "0");
    assert.fieldEquals("Trade", takerTradeId, "netQuantityAfter", qty.toString());
    assert.fieldEquals("Trade", takerTradeId, "aggregatedEntryPriceAfter", price.toString());
    assert.fieldEquals("Trade", takerTradeId, "fillCount", "1");
    assert.fieldEquals("Trade", takerTradeId, "timestamp", event.block.timestamp.toString());
    assert.fieldEquals("Trade", takerTradeId, "blockNumber", event.block.number.toString());
    assert.fieldEquals("Trade", takerTradeId, "transactionHash", event.transaction.hash.toHexString());

    // Trade assertions (maker)
    const makerTradeId = event.transaction.hash.concat(maker).toHexString();
    assert.fieldEquals("Trade", makerTradeId, "user", maker.toHexString());
    assert.fieldEquals("Trade", makerTradeId, "positionSession", makerSessionId);
    assert.fieldEquals("Trade", makerTradeId, "tradeQuantity", qty.neg().toString());
    assert.fieldEquals("Trade", makerTradeId, "tradingFee", "0");
    assert.fieldEquals("Trade", makerTradeId, "realizedPnl", "0");
    assert.fieldEquals("Trade", makerTradeId, "netQuantityAfter", qty.neg().toString());
    assert.fieldEquals("Trade", makerTradeId, "aggregatedEntryPriceAfter", price.toString());

    // PositionSession assertions (taker: sideIndex=0)
    assert.fieldEquals("PositionSession", takerSessionId, "status", "OPEN");
    assert.fieldEquals("PositionSession", takerSessionId, "user", taker.toHexString());
    assert.fieldEquals("PositionSession", takerSessionId, "entryPrice", price.toString());
    assert.fieldEquals("PositionSession", takerSessionId, "closePrice", "0");
    assert.fieldEquals("PositionSession", takerSessionId, "maxQuantity", qty.toString());
    assert.fieldEquals("PositionSession", takerSessionId, "closedQuantity", "0");
    assert.fieldEquals("PositionSession", takerSessionId, "realizedPnl", "0");
    assert.fieldEquals("PositionSession", takerSessionId, "tradingFees", "0");
    assert.fieldEquals("PositionSession", takerSessionId, "fundingFees", "0");
    assert.fieldEquals("PositionSession", takerSessionId, "openedAt", event.block.timestamp.toString());
    assert.fieldEquals("PositionSession", takerSessionId, "lastTradeAt", event.block.timestamp.toString());

    // User currentPositionSessionId
    assert.fieldEquals("User", taker.toHexString(), "currentPositionSessionId", takerSessionId);

    // Fill links to session and trade
    assert.fieldEquals("Fill", takerFillId, "positionSession", takerSessionId);
    assert.fieldEquals("Fill", takerFillId, "trade", takerTradeId);
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
    assert.fieldEquals("Trade", takerTradeId, "tradeQuantity", qty1.plus(qty2).toString());
    assert.fieldEquals("Trade", takerTradeId, "tradePrice", price.toString());
  });

  test("closes position session on full close with all session fields", () => {
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

    const sessionId = positionSessionId(openEvent.block.number, openEvent.logIndex.toI32() * 2);
    assert.fieldEquals("PositionSession", sessionId, "status", "OPEN");
    assert.fieldEquals("PositionSession", sessionId, "entryPrice", entryPrice.toString());
    assert.fieldEquals("PositionSession", sessionId, "openedAt", openEvent.block.timestamp.toString());
    assert.fieldEquals("PositionSession", sessionId, "user", trader.toHexString());
    assert.fieldEquals("User", trader.toHexString(), "currentPositionSessionId", sessionId);

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
    assert.fieldEquals("PositionSession", sessionId, "closePrice", exitPrice.toString());
    assert.fieldEquals("PositionSession", sessionId, "maxQuantity", qty.toString());
    assert.fieldEquals("PositionSession", sessionId, "tradingFees", "0");
    assert.fieldEquals("PositionSession", sessionId, "lastTradeAt", closeEvent.block.timestamp.toString());

    assert.fieldEquals("User", trader.toHexString(), "currentPositionSessionId", "");

    // Close-side Trade should have realizedPnl and link to session
    const closeTradeId = closeEvent.transaction.hash.concat(trader).toHexString();
    assert.fieldEquals("Trade", closeTradeId, "positionSession", sessionId);
    assert.fieldEquals("Trade", closeTradeId, "realizedPnl", "100000");
    assert.fieldEquals("Trade", closeTradeId, "tradeQuantity", qty.neg().toString());
  });

  test("trading fees flow to Fill, Trade, and PositionSession", () => {
    const maker = userAddress(1);
    const taker = userAddress(2);
    const price = BigInt.fromI32(3000000);
    const qty = BigInt.fromI32(1000000);
    const takerFee = BigInt.fromI32(5000);
    const makerFee = BigInt.fromI32(-2000);

    const event = createOrderMatchedEvent(
      orderId(1), maker, taker, price,
      qty, makerFee, takerFee,
      qty.neg(), qty, price, price,
    );
    event.logIndex = BigInt.fromI32(1);
    event.transaction.hash = orderId(100);
    handleOrderMatched(event);

    const baseId = createEventId(event.transaction.hash, event.logIndex);
    const takerFillId = baseId.concatI32(0).toHexString();
    const makerFillId = baseId.concatI32(1).toHexString();

    assert.fieldEquals("Fill", takerFillId, "tradingFee", takerFee.toString());
    assert.fieldEquals("Fill", makerFillId, "tradingFee", makerFee.toString());

    const takerTradeId = event.transaction.hash.concat(taker).toHexString();
    const makerTradeId = event.transaction.hash.concat(maker).toHexString();
    assert.fieldEquals("Trade", takerTradeId, "tradingFee", takerFee.toString());
    assert.fieldEquals("Trade", makerTradeId, "tradingFee", makerFee.toString());

    const takerSessionId = positionSessionId(event.block.number, event.logIndex.toI32() * 2);
    const makerSessionId = positionSessionId(event.block.number, event.logIndex.toI32() * 2 + 1);
    assert.fieldEquals("PositionSession", takerSessionId, "tradingFees", takerFee.toString());
    assert.fieldEquals("PositionSession", makerSessionId, "tradingFees", makerFee.toString());
  });
});
