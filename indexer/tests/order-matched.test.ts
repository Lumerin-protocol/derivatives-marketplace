import { describe, test, beforeEach, clearStore } from "matchstick-as/assembly/index";
import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts";
import { newTypedMockEventWithParams } from "matchstick-as/assembly/defaults";
import { handleOrderMatched } from "../src/perps";
import { OrderMatched } from "../generated/HashPowerPerpsDEX/HashPowerPerpsDEX";
import { assert } from "matchstick-as/assembly/index";
import {
  userAddress,
  orderId,
  paramAddr,
  paramBytes,
  paramUint,
  paramInt,
  setupDataSourceMock,
  setupPerps,
} from "./helpers";
import { positionSessionId, createEventId, tradeId } from "../src/ids";

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
      mOid,
      maker,
      taker,
      price,
      qty,
      BigInt.zero(),
      BigInt.zero(),
      qty.neg(),
      qty,
      price,
      price,
    );
    handleOrderMatched(event);

    assert.fieldEquals("User", taker.toHexString(), "netQuantity", qty.toString());
    assert.fieldEquals("User", maker.toHexString(), "netQuantity", qty.neg().toString());
    assert.fieldEquals("User", taker.toHexString(), "tradeCount", "1");
    assert.fieldEquals("User", maker.toHexString(), "tradeCount", "1");

    assert.entityCount("Fill", 2);
    assert.entityCount("Trade", 2);
    assert.entityCount("PositionSession", 2);
    // One Trade row per (tx, user, session): the taker's and the maker's.
    assert.fieldEquals("Perps", "0", "totalTrades", "2");
    assert.fieldEquals("Perps", "0", "totalFills", "2");

    // volume = price * absQty / quantityScale = 3000000 * 1000000 / 1000000 = 3000000
    assert.fieldEquals("Perps", "0", "totalVolume", "3000000");

    // Fill IDs: fillId(txHash, logIndex, legIndex), legIndex = sideIndex here
    const baseId = createEventId(event.transaction.hash, event.logIndex);
    const takerFillId = baseId.concatI32(0).toHexString();
    const makerFillId = baseId.concatI32(1).toHexString();

    // Session IDs
    const takerSessionId = positionSessionId(event.block.number, event.logIndex, 0);
    const makerSessionId = positionSessionId(event.block.number, event.logIndex, 1);

    // Taker fill (buyer, +qty)
    assert.fieldEquals("Fill", takerFillId, "fillPrice", price.toString());
    assert.fieldEquals("Fill", takerFillId, "fillQuantity", qty.toString());
    assert.fieldEquals("Fill", takerFillId, "netQuantityAfter", qty.toString());
    assert.fieldEquals("Fill", takerFillId, "aggregatedEntryPriceAfter", price.toString());
    assert.fieldEquals("Fill", takerFillId, "realizedPnl", "0");
    assert.fieldEquals("Fill", takerFillId, "tradingFee", "0");
    assert.fieldEquals("Fill", takerFillId, "side", "TAKER");
    assert.fieldEquals("Fill", takerFillId, "user", taker.toHexString());
    assert.fieldEquals("Fill", takerFillId, "counterparty", maker.toHexString());
    assert.fieldEquals("Fill", takerFillId, "counterpartyOrder", mOid.toHexString());
    assert.fieldEquals("Fill", takerFillId, "timestamp", event.block.timestamp.toString());
    assert.fieldEquals("Fill", takerFillId, "blockNumber", event.block.number.toString());
    assert.fieldEquals(
      "Fill",
      takerFillId,
      "transactionHash",
      event.transaction.hash.toHexString(),
    );

    // Maker fill (seller, -qty)
    assert.fieldEquals("Fill", makerFillId, "fillPrice", price.toString());
    assert.fieldEquals("Fill", makerFillId, "fillQuantity", qty.neg().toString());
    assert.fieldEquals("Fill", makerFillId, "netQuantityAfter", qty.neg().toString());
    assert.fieldEquals("Fill", makerFillId, "aggregatedEntryPriceAfter", price.toString());
    assert.fieldEquals("Fill", makerFillId, "realizedPnl", "0");
    assert.fieldEquals("Fill", makerFillId, "tradingFee", "0");
    assert.fieldEquals("Fill", makerFillId, "side", "MAKER");
    assert.fieldEquals("Fill", makerFillId, "user", maker.toHexString());
    assert.fieldEquals("Fill", makerFillId, "counterparty", taker.toHexString());
    assert.fieldEquals("Fill", makerFillId, "order", mOid.toHexString());

    // Trade assertions (taker)
    const takerTradeId = tradeId(
      event.transaction.hash,
      taker,
      takerSessionId,
    ).toHexString();
    assert.fieldEquals("Trade", takerTradeId, "user", taker.toHexString());
    assert.fieldEquals("Trade", takerTradeId, "positionSession", takerSessionId);
    assert.fieldEquals("Trade", takerTradeId, "tradePrice", price.toString());
    assert.fieldEquals("Trade", takerTradeId, "tradeQuantity", qty.toString());
    assert.fieldEquals("Trade", takerTradeId, "tradingFee", "0");
    assert.fieldEquals("Trade", takerTradeId, "realizedPnl", "0");
    assert.fieldEquals("Trade", takerTradeId, "cumulativeRealizedPnl", "0");
    assert.fieldEquals("Trade", takerTradeId, "netQuantityAfter", qty.toString());
    assert.fieldEquals("Trade", takerTradeId, "aggregatedEntryPriceAfter", price.toString());
    assert.fieldEquals("Trade", takerTradeId, "fillCount", "1");
    assert.fieldEquals("Trade", takerTradeId, "timestamp", event.block.timestamp.toString());
    assert.fieldEquals("Trade", takerTradeId, "blockNumber", event.block.number.toString());
    assert.fieldEquals(
      "Trade",
      takerTradeId,
      "transactionHash",
      event.transaction.hash.toHexString(),
    );

    // Trade assertions (maker)
    const makerTradeId = tradeId(
      event.transaction.hash,
      maker,
      makerSessionId,
    ).toHexString();
    assert.fieldEquals("Trade", makerTradeId, "user", maker.toHexString());
    assert.fieldEquals("Trade", makerTradeId, "positionSession", makerSessionId);
    assert.fieldEquals("Trade", makerTradeId, "tradeQuantity", qty.neg().toString());
    assert.fieldEquals("Trade", makerTradeId, "tradingFee", "0");
    assert.fieldEquals("Trade", makerTradeId, "realizedPnl", "0");
    assert.fieldEquals("Trade", makerTradeId, "cumulativeRealizedPnl", "0");
    assert.fieldEquals("Trade", makerTradeId, "netQuantityAfter", qty.neg().toString());
    assert.fieldEquals("Trade", makerTradeId, "aggregatedEntryPriceAfter", price.toString());

    // PositionSession assertions (taker: sideIndex=0)
    assert.fieldEquals("PositionSession", takerSessionId, "status", "OPEN");
    assert.fieldEquals("PositionSession", takerSessionId, "user", taker.toHexString());
    assert.fieldEquals("PositionSession", takerSessionId, "entryPrice", price.toString());
    assert.fieldEquals("PositionSession", takerSessionId, "closePrice", "0");
    assert.fieldEquals("PositionSession", takerSessionId, "netQuantity", qty.toString());
    assert.fieldEquals("PositionSession", takerSessionId, "maxQuantity", qty.toString());
    assert.fieldEquals("PositionSession", takerSessionId, "closedQuantity", "0");
    assert.fieldEquals("PositionSession", takerSessionId, "realizedPnl", "0");
    assert.fieldEquals("PositionSession", takerSessionId, "tradingFees", "0");
    assert.fieldEquals("PositionSession", takerSessionId, "fundingFees", "0");
    assert.fieldEquals(
      "PositionSession",
      takerSessionId,
      "openedAt",
      event.block.timestamp.toString(),
    );
    assert.fieldEquals(
      "PositionSession",
      takerSessionId,
      "lastTradeAt",
      event.block.timestamp.toString(),
    );

    // User currentSessionId
    assert.fieldEquals("User", taker.toHexString(), "currentSessionId", takerSessionId);

    // Fill links to session and trade
    assert.fieldEquals("Fill", takerFillId, "positionSession", takerSessionId);
    assert.fieldEquals("Fill", takerFillId, "trade", takerTradeId);
  });

  test("handles self-match flat-to-flat without missing session entryPrice", () => {
    const selfTrader = userAddress(7);
    const price = BigInt.fromI32(3000000);
    const qty = BigInt.fromI32(1000000);
    const txHash = orderId(700);
    const logIndex = BigInt.fromI32(56);

    const event = createOrderMatchedEvent(
      orderId(701),
      selfTrader,
      selfTrader,
      price,
      qty,
      BigInt.zero(),
      BigInt.zero(),
      BigInt.zero(),
      BigInt.zero(),
      BigInt.zero(),
      BigInt.zero(),
    );
    event.logIndex = logIndex;
    event.transaction.hash = txHash;
    handleOrderMatched(event);

    const takerSessionId = positionSessionId(event.block.number, event.logIndex, 0);
    const makerSessionId = positionSessionId(event.block.number, event.logIndex, 1);

    assert.fieldEquals("PositionSession", takerSessionId, "status", "CLOSE");
    assert.fieldEquals("PositionSession", takerSessionId, "entryPrice", "0");
    assert.fieldEquals("PositionSession", makerSessionId, "status", "CLOSE");
    assert.fieldEquals("PositionSession", makerSessionId, "entryPrice", "0");

    assert.fieldEquals("User", selfTrader.toHexString(), "netQuantity", "0");
    assert.fieldEquals("User", selfTrader.toHexString(), "aggregatedEntryPrice", "0");
    assert.fieldEquals("User", selfTrader.toHexString(), "currentSessionId", "");
    // Both legs belong to the same user but to two different sessions, so they
    // stay in two Trade rows instead of collapsing into one.
    assert.entityCount("Trade", 2);
    assert.entityCount("Fill", 2);
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
      orderId(1),
      maker1,
      trader,
      entryPrice,
      qty,
      BigInt.zero(),
      BigInt.zero(),
      qty.neg(),
      qty,
      entryPrice,
      entryPrice,
    );
    openEvent.logIndex = BigInt.fromI32(1);
    openEvent.transaction.hash = orderId(100);
    handleOrderMatched(openEvent);

    assert.fieldEquals("User", trader.toHexString(), "netQuantity", qty.toString());

    // Close: trader (taker) sells -qty at exitPrice
    const closeEvent = createOrderMatchedEvent(
      orderId(2),
      maker2,
      trader,
      exitPrice,
      qty.neg(),
      BigInt.zero(),
      BigInt.zero(),
      qty,
      BigInt.zero(),
      exitPrice,
      BigInt.zero(),
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
      orderId(1),
      maker1,
      taker,
      price1,
      qty,
      BigInt.zero(),
      BigInt.zero(),
      qty.neg(),
      qty,
      price1,
      price1,
    );
    event1.logIndex = BigInt.fromI32(1);
    event1.transaction.hash = orderId(100);
    handleOrderMatched(event1);

    // Second fill: taker buys 1 unit at 3200000, avg entry = 3100000
    const event2 = createOrderMatchedEvent(
      orderId(2),
      maker2,
      taker,
      price2,
      qty,
      BigInt.zero(),
      BigInt.zero(),
      qty.neg(),
      qty.plus(qty),
      price2,
      avgPrice,
    );
    event2.logIndex = BigInt.fromI32(2);
    event2.transaction.hash = orderId(101);
    handleOrderMatched(event2);

    assert.fieldEquals("User", taker.toHexString(), "netQuantity", qty.plus(qty).toString());
    assert.fieldEquals("User", taker.toHexString(), "aggregatedEntryPrice", "3100000");
    // PositionSession.entryPrice must be updated when adding to an existing position (scale-in)
    const sessionId = positionSessionId(event1.block.number, event1.logIndex, 0);
    assert.fieldEquals("PositionSession", sessionId, "entryPrice", "3100000");
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
      orderId(1),
      maker1,
      taker,
      price,
      qty1,
      BigInt.zero(),
      BigInt.zero(),
      qty1.neg(),
      qty1,
      price,
      price,
    );
    event1.logIndex = BigInt.fromI32(1);
    event1.transaction.hash = txHash;
    handleOrderMatched(event1);

    const event2 = createOrderMatchedEvent(
      orderId(2),
      maker2,
      taker,
      price,
      qty2,
      BigInt.zero(),
      BigInt.zero(),
      qty2.neg(),
      qty1.plus(qty2),
      price,
      price,
    );
    event2.logIndex = BigInt.fromI32(2);
    event2.transaction.hash = txHash;
    handleOrderMatched(event2);

    assert.entityCount("Fill", 4);
    const takerSessionId = positionSessionId(
      event1.block.number,
      event1.logIndex,
      0,
    );
    const takerTradeId = tradeId(txHash, taker, takerSessionId).toHexString();
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
      orderId(1),
      maker1,
      trader,
      entryPrice,
      qty,
      BigInt.zero(),
      BigInt.zero(),
      qty.neg(),
      qty,
      entryPrice,
      entryPrice,
    );
    openEvent.logIndex = BigInt.fromI32(1);
    openEvent.transaction.hash = orderId(100);
    handleOrderMatched(openEvent);

    const sessionId = positionSessionId(openEvent.block.number, openEvent.logIndex, 0);
    assert.fieldEquals("PositionSession", sessionId, "status", "OPEN");
    assert.fieldEquals("PositionSession", sessionId, "entryPrice", entryPrice.toString());
    assert.fieldEquals(
      "PositionSession",
      sessionId,
      "openedAt",
      openEvent.block.timestamp.toString(),
    );
    assert.fieldEquals("PositionSession", sessionId, "user", trader.toHexString());
    assert.fieldEquals("User", trader.toHexString(), "currentSessionId", sessionId);

    const closeEvent = createOrderMatchedEvent(
      orderId(2),
      maker2,
      trader,
      exitPrice,
      qty.neg(),
      BigInt.zero(),
      BigInt.zero(),
      qty,
      BigInt.zero(),
      exitPrice,
      BigInt.zero(),
    );
    closeEvent.logIndex = BigInt.fromI32(2);
    closeEvent.transaction.hash = orderId(101);
    handleOrderMatched(closeEvent);

    assert.fieldEquals("PositionSession", sessionId, "status", "CLOSE");
    assert.fieldEquals("PositionSession", sessionId, "entryPrice", entryPrice.toString());
    assert.fieldEquals("PositionSession", sessionId, "realizedPnl", "100000");
    assert.fieldEquals("PositionSession", sessionId, "closedQuantity", qty.toString());
    assert.fieldEquals("PositionSession", sessionId, "closePrice", exitPrice.toString());
    assert.fieldEquals("PositionSession", sessionId, "maxQuantity", qty.toString());
    assert.fieldEquals("PositionSession", sessionId, "tradingFees", "0");
    assert.fieldEquals(
      "PositionSession",
      sessionId,
      "lastTradeAt",
      closeEvent.block.timestamp.toString(),
    );

    assert.fieldEquals("User", trader.toHexString(), "currentSessionId", "");

    // Close-side Trade should have realizedPnl and link to session
    const closeTradeId = tradeId(
      closeEvent.transaction.hash,
      trader,
      sessionId,
    ).toHexString();
    assert.fieldEquals("Trade", closeTradeId, "positionSession", sessionId);
    assert.fieldEquals("Trade", closeTradeId, "realizedPnl", "100000");
    assert.fieldEquals("Trade", closeTradeId, "cumulativeRealizedPnl", "100000");
    assert.fieldEquals("Trade", closeTradeId, "tradeQuantity", qty.neg().toString());
  });

  test("computes realized PnL when closing a short position", () => {
    const maker1 = userAddress(1);
    const trader = userAddress(2);
    const maker2 = userAddress(3);
    const entryPrice = BigInt.fromI32(3000000);
    const exitPrice = BigInt.fromI32(2900000);
    const qty = BigInt.fromI32(1000000);

    // Open: trader (taker) sells -qty at entryPrice → short
    const openEvent = createOrderMatchedEvent(
      orderId(1),
      maker1,
      trader,
      entryPrice,
      qty.neg(),
      BigInt.zero(),
      BigInt.zero(),
      qty,
      qty.neg(),
      entryPrice,
      entryPrice,
    );
    openEvent.logIndex = BigInt.fromI32(1);
    openEvent.transaction.hash = orderId(100);
    handleOrderMatched(openEvent);

    assert.fieldEquals("User", trader.toHexString(), "netQuantity", qty.neg().toString());

    // Close: trader (taker) buys +qty at exitPrice → flat
    const closeEvent = createOrderMatchedEvent(
      orderId(2),
      maker2,
      trader,
      exitPrice,
      qty,
      BigInt.zero(),
      BigInt.zero(),
      qty.neg(),
      BigInt.zero(),
      exitPrice,
      BigInt.zero(),
    );
    closeEvent.logIndex = BigInt.fromI32(2);
    closeEvent.transaction.hash = orderId(101);
    handleOrderMatched(closeEvent);

    // PnL = (2900000 - 3000000) * (-1000000) / 1000000 = 100000
    assert.fieldEquals("User", trader.toHexString(), "netQuantity", "0");
    assert.fieldEquals("User", trader.toHexString(), "realizedPnl", "100000");

    const closeFillId = createEventId(closeEvent.transaction.hash, closeEvent.logIndex)
      .concatI32(0)
      .toHexString();
    assert.fieldEquals("Fill", closeFillId, "realizedPnl", "100000");

    const sessionId = positionSessionId(openEvent.block.number, openEvent.logIndex, 0);
    const closeTradeId = tradeId(
      closeEvent.transaction.hash,
      trader,
      sessionId,
    ).toHexString();
    assert.fieldEquals("Trade", closeTradeId, "realizedPnl", "100000");
    assert.fieldEquals("Trade", closeTradeId, "cumulativeRealizedPnl", "100000");

    assert.fieldEquals("PositionSession", sessionId, "realizedPnl", "100000");
    assert.fieldEquals("PositionSession", sessionId, "status", "CLOSE");
  });

  test("computes negative realized PnL when closing at a loss", () => {
    const maker1 = userAddress(1);
    const trader = userAddress(2);
    const maker2 = userAddress(3);
    const entryPrice = BigInt.fromI32(3100000);
    const exitPrice = BigInt.fromI32(3000000);
    const qty = BigInt.fromI32(1000000);

    // Open: trader buys +qty at entryPrice
    const openEvent = createOrderMatchedEvent(
      orderId(1),
      maker1,
      trader,
      entryPrice,
      qty,
      BigInt.zero(),
      BigInt.zero(),
      qty.neg(),
      qty,
      entryPrice,
      entryPrice,
    );
    openEvent.logIndex = BigInt.fromI32(1);
    openEvent.transaction.hash = orderId(100);
    handleOrderMatched(openEvent);

    // Close: trader sells -qty at exitPrice (loss)
    const closeEvent = createOrderMatchedEvent(
      orderId(2),
      maker2,
      trader,
      exitPrice,
      qty.neg(),
      BigInt.zero(),
      BigInt.zero(),
      qty,
      BigInt.zero(),
      exitPrice,
      BigInt.zero(),
    );
    closeEvent.logIndex = BigInt.fromI32(2);
    closeEvent.transaction.hash = orderId(101);
    handleOrderMatched(closeEvent);

    // PnL = (3000000 - 3100000) * 1000000 / 1000000 = -100000
    assert.fieldEquals("User", trader.toHexString(), "realizedPnl", "-100000");

    const closeFillId = createEventId(closeEvent.transaction.hash, closeEvent.logIndex)
      .concatI32(0)
      .toHexString();
    assert.fieldEquals("Fill", closeFillId, "realizedPnl", "-100000");

    const sessionId = positionSessionId(openEvent.block.number, openEvent.logIndex, 0);
    const closeTradeId = tradeId(
      closeEvent.transaction.hash,
      trader,
      sessionId,
    ).toHexString();
    assert.fieldEquals("Trade", closeTradeId, "realizedPnl", "-100000");
    assert.fieldEquals("Trade", closeTradeId, "cumulativeRealizedPnl", "-100000");

    assert.fieldEquals("PositionSession", sessionId, "realizedPnl", "-100000");
  });

  test("computes PnL on partial close proportional to settled quantity", () => {
    const maker1 = userAddress(1);
    const trader = userAddress(2);
    const maker2 = userAddress(3);
    const entryPrice = BigInt.fromI32(3000000);
    const exitPrice = BigInt.fromI32(3100000);
    const qty = BigInt.fromI32(2000000);
    const halfQty = BigInt.fromI32(1000000);

    // Open: trader buys 2 units at entryPrice
    const openEvent = createOrderMatchedEvent(
      orderId(1),
      maker1,
      trader,
      entryPrice,
      qty,
      BigInt.zero(),
      BigInt.zero(),
      qty.neg(),
      qty,
      entryPrice,
      entryPrice,
    );
    openEvent.logIndex = BigInt.fromI32(1);
    openEvent.transaction.hash = orderId(100);
    handleOrderMatched(openEvent);

    // Partial close: trader sells 1 unit at exitPrice
    const closeEvent = createOrderMatchedEvent(
      orderId(2),
      maker2,
      trader,
      exitPrice,
      halfQty.neg(),
      BigInt.zero(),
      BigInt.zero(),
      halfQty,
      halfQty,
      exitPrice,
      entryPrice,
    );
    closeEvent.logIndex = BigInt.fromI32(2);
    closeEvent.transaction.hash = orderId(101);
    handleOrderMatched(closeEvent);

    // PnL = (3100000 - 3000000) * 1000000 / 1000000 = 100000
    assert.fieldEquals("User", trader.toHexString(), "netQuantity", halfQty.toString());
    assert.fieldEquals("User", trader.toHexString(), "realizedPnl", "100000");

    const sessionId = positionSessionId(openEvent.block.number, openEvent.logIndex, 0);
    assert.fieldEquals("PositionSession", sessionId, "status", "OPEN");
    assert.fieldEquals("PositionSession", sessionId, "realizedPnl", "100000");
    assert.fieldEquals("PositionSession", sessionId, "closedQuantity", halfQty.toString());
    assert.fieldEquals("PositionSession", sessionId, "closePrice", exitPrice.toString());

    const closeFillId = createEventId(closeEvent.transaction.hash, closeEvent.logIndex)
      .concatI32(0)
      .toHexString();
    assert.fieldEquals("Fill", closeFillId, "realizedPnl", "100000");
  });

  test("computes PnL on position flip and creates two sessions", () => {
    const maker1 = userAddress(1);
    const trader = userAddress(2);
    const maker2 = userAddress(3);
    const entryPrice = BigInt.fromI32(3000000);
    const flipPrice = BigInt.fromI32(3100000);
    const qty = BigInt.fromI32(1000000);

    // Open: trader buys +1 unit at entryPrice
    const openEvent = createOrderMatchedEvent(
      orderId(1),
      maker1,
      trader,
      entryPrice,
      qty,
      BigInt.zero(),
      BigInt.zero(),
      qty.neg(),
      qty,
      entryPrice,
      entryPrice,
    );
    openEvent.logIndex = BigInt.fromI32(1);
    openEvent.transaction.hash = orderId(100);
    handleOrderMatched(openEvent);

    const oldSessionId = positionSessionId(openEvent.block.number, openEvent.logIndex, 0);
    assert.fieldEquals("PositionSession", oldSessionId, "status", "OPEN");

    // Flip: trader sells 2 units at flipPrice → goes from +1 to -1
    const flipEvent = createOrderMatchedEvent(
      orderId(2),
      maker2,
      trader,
      flipPrice,
      qty.times(BigInt.fromI32(-2)),
      BigInt.zero(),
      BigInt.zero(),
      qty.times(BigInt.fromI32(2)),
      qty.neg(),
      flipPrice,
      flipPrice,
    );
    flipEvent.logIndex = BigInt.fromI32(2);
    flipEvent.transaction.hash = orderId(101);
    handleOrderMatched(flipEvent);

    // PnL on closed 1 unit: (3100000 - 3000000) * 1000000 / 1000000 = 100000
    assert.fieldEquals("User", trader.toHexString(), "netQuantity", qty.neg().toString());
    assert.fieldEquals("User", trader.toHexString(), "realizedPnl", "100000");

    // Old session closed with PnL
    assert.fieldEquals("PositionSession", oldSessionId, "status", "CLOSE");
    assert.fieldEquals("PositionSession", oldSessionId, "realizedPnl", "100000");
    assert.fieldEquals("PositionSession", oldSessionId, "netQuantity", "0");

    // New session opened with zero PnL, carrying only the flipped-into size.
    const newSessionId = positionSessionId(flipEvent.block.number, flipEvent.logIndex, 0);
    assert.fieldEquals("PositionSession", newSessionId, "status", "OPEN");
    assert.fieldEquals("PositionSession", newSessionId, "realizedPnl", "0");
    assert.fieldEquals("PositionSession", newSessionId, "entryPrice", flipPrice.toString());
    assert.fieldEquals("PositionSession", newSessionId, "netQuantity", qty.neg().toString());

    // Close fill carries PnL, open fill has zero. The re-opening leg sits at
    // leg index sideIndex + 2 so it cannot collide with the maker's leg.
    const baseId = createEventId(flipEvent.transaction.hash, flipEvent.logIndex);
    const closeFillId = baseId.concatI32(0).toHexString();
    const openFillId = baseId.concatI32(2).toHexString();
    assert.fieldEquals("Fill", closeFillId, "realizedPnl", "100000");
    assert.fieldEquals("Fill", openFillId, "realizedPnl", "0");

    // One Trade row per session: the reversal's PnL stays on the closed
    // session's row and the new session's row starts clean.
    const closeTradeId = tradeId(
      flipEvent.transaction.hash,
      trader,
      oldSessionId,
    ).toHexString();
    const openTradeId = tradeId(
      flipEvent.transaction.hash,
      trader,
      newSessionId,
    ).toHexString();
    assert.fieldEquals("Trade", closeTradeId, "realizedPnl", "100000");
    assert.fieldEquals("Trade", closeTradeId, "fillCount", "1");
    assert.fieldEquals("Trade", closeTradeId, "positionSession", oldSessionId);
    assert.fieldEquals("Trade", closeTradeId, "cumulativeRealizedPnl", "100000");
    assert.fieldEquals("Trade", openTradeId, "realizedPnl", "0");
    assert.fieldEquals("Trade", openTradeId, "fillCount", "1");
    assert.fieldEquals("Trade", openTradeId, "positionSession", newSessionId);
    assert.fieldEquals("Trade", openTradeId, "cumulativeRealizedPnl", "100000");
  });

  test("accumulates realized PnL across multiple round-trips", () => {
    const maker1 = userAddress(1);
    const trader = userAddress(2);
    const maker2 = userAddress(3);
    const maker3 = userAddress(4);
    const maker4 = userAddress(5);
    const qty = BigInt.fromI32(1000000);

    // Round 1: open long at 3000000, close at 3100000 → +100000
    const open1 = createOrderMatchedEvent(
      orderId(1),
      maker1,
      trader,
      BigInt.fromI32(3000000),
      qty,
      BigInt.zero(),
      BigInt.zero(),
      qty.neg(),
      qty,
      BigInt.fromI32(3000000),
      BigInt.fromI32(3000000),
    );
    open1.logIndex = BigInt.fromI32(1);
    open1.transaction.hash = orderId(100);
    handleOrderMatched(open1);

    const close1 = createOrderMatchedEvent(
      orderId(2),
      maker2,
      trader,
      BigInt.fromI32(3100000),
      qty.neg(),
      BigInt.zero(),
      BigInt.zero(),
      qty,
      BigInt.zero(),
      BigInt.fromI32(3100000),
      BigInt.zero(),
    );
    close1.logIndex = BigInt.fromI32(2);
    close1.transaction.hash = orderId(101);
    handleOrderMatched(close1);

    assert.fieldEquals("User", trader.toHexString(), "realizedPnl", "100000");

    // Round 2: open long at 3200000, close at 3000000 → -200000
    const open2 = createOrderMatchedEvent(
      orderId(3),
      maker3,
      trader,
      BigInt.fromI32(3200000),
      qty,
      BigInt.zero(),
      BigInt.zero(),
      qty.neg(),
      qty,
      BigInt.fromI32(3200000),
      BigInt.fromI32(3200000),
    );
    open2.logIndex = BigInt.fromI32(3);
    open2.transaction.hash = orderId(102);
    handleOrderMatched(open2);

    const close2 = createOrderMatchedEvent(
      orderId(4),
      maker4,
      trader,
      BigInt.fromI32(3000000),
      qty.neg(),
      BigInt.zero(),
      BigInt.zero(),
      qty,
      BigInt.zero(),
      BigInt.fromI32(3000000),
      BigInt.zero(),
    );
    close2.logIndex = BigInt.fromI32(4);
    close2.transaction.hash = orderId(103);
    handleOrderMatched(close2);

    // Cumulative: 100000 + (-200000) = -100000
    assert.fieldEquals("User", trader.toHexString(), "realizedPnl", "-100000");
  });

  test("aggregates realized PnL across multiple close fills in one trade", () => {
    const maker1 = userAddress(1);
    const trader = userAddress(2);
    const maker2 = userAddress(3);
    const maker3 = userAddress(4);
    const entryPrice = BigInt.fromI32(3000000);
    const qty = BigInt.fromI32(2000000);
    const halfQty = BigInt.fromI32(1000000);
    const closeTxHash = orderId(101);

    // Open: trader buys 2 units at 3000000
    const openEvent = createOrderMatchedEvent(
      orderId(1),
      maker1,
      trader,
      entryPrice,
      qty,
      BigInt.zero(),
      BigInt.zero(),
      qty.neg(),
      qty,
      entryPrice,
      entryPrice,
    );
    openEvent.logIndex = BigInt.fromI32(1);
    openEvent.transaction.hash = orderId(100);
    handleOrderMatched(openEvent);

    // Close fill 1 (same tx): sell 1 unit at 3100000
    const close1 = createOrderMatchedEvent(
      orderId(2),
      maker2,
      trader,
      BigInt.fromI32(3100000),
      halfQty.neg(),
      BigInt.zero(),
      BigInt.zero(),
      halfQty,
      halfQty,
      BigInt.fromI32(3100000),
      entryPrice,
    );
    close1.logIndex = BigInt.fromI32(2);
    close1.transaction.hash = closeTxHash;
    handleOrderMatched(close1);

    // Close fill 2 (same tx): sell 1 unit at 3200000
    const close2 = createOrderMatchedEvent(
      orderId(3),
      maker3,
      trader,
      BigInt.fromI32(3200000),
      halfQty.neg(),
      BigInt.zero(),
      BigInt.zero(),
      halfQty,
      BigInt.zero(),
      BigInt.fromI32(3200000),
      BigInt.zero(),
    );
    close2.logIndex = BigInt.fromI32(3);
    close2.transaction.hash = closeTxHash;
    handleOrderMatched(close2);

    // Fill 1 PnL = (3100000 - 3000000) * 1000000 / 1000000 = 100000
    // Fill 2 PnL = (3200000 - 3000000) * 1000000 / 1000000 = 200000
    const sessionId = positionSessionId(
      openEvent.block.number,
      openEvent.logIndex,
      0,
    );
    const closeTradeId = tradeId(closeTxHash, trader, sessionId).toHexString();
    assert.fieldEquals("Trade", closeTradeId, "realizedPnl", "300000");
    assert.fieldEquals("Trade", closeTradeId, "fillCount", "2");
    assert.fieldEquals("Trade", closeTradeId, "cumulativeRealizedPnl", "300000");
    assert.fieldEquals("User", trader.toHexString(), "realizedPnl", "300000");
  });

  test("trading fees flow to Fill, Trade, and PositionSession", () => {
    const maker = userAddress(1);
    const taker = userAddress(2);
    const price = BigInt.fromI32(3000000);
    const qty = BigInt.fromI32(1000000);
    const takerFee = BigInt.fromI32(5000);
    const makerFee = BigInt.fromI32(-2000);

    const event = createOrderMatchedEvent(
      orderId(1),
      maker,
      taker,
      price,
      qty,
      makerFee,
      takerFee,
      qty.neg(),
      qty,
      price,
      price,
    );
    event.logIndex = BigInt.fromI32(1);
    event.transaction.hash = orderId(100);
    handleOrderMatched(event);

    const baseId = createEventId(event.transaction.hash, event.logIndex);
    const takerFillId = baseId.concatI32(0).toHexString();
    const makerFillId = baseId.concatI32(1).toHexString();

    assert.fieldEquals("Fill", takerFillId, "tradingFee", takerFee.toString());
    assert.fieldEquals("Fill", makerFillId, "tradingFee", makerFee.toString());

    const takerSessionId = positionSessionId(event.block.number, event.logIndex, 0);
    const makerSessionId = positionSessionId(event.block.number, event.logIndex, 1);
    const takerTradeId = tradeId(
      event.transaction.hash,
      taker,
      takerSessionId,
    ).toHexString();
    const makerTradeId = tradeId(
      event.transaction.hash,
      maker,
      makerSessionId,
    ).toHexString();
    assert.fieldEquals("Trade", takerTradeId, "tradingFee", takerFee.toString());
    assert.fieldEquals("Trade", makerTradeId, "tradingFee", makerFee.toString());

    assert.fieldEquals("PositionSession", takerSessionId, "tradingFees", takerFee.toString());
    assert.fieldEquals("PositionSession", makerSessionId, "tradingFees", makerFee.toString());
  });
});

describe("Trade.cumulativeRealizedPnl sequential sessions", () => {
  beforeEach(() => {
    clearStore();
    setupDataSourceMock();
    setupPerps();
  });

  test("second close snapshots lifetime total including the first session", () => {
    const maker1 = userAddress(1);
    const maker2 = userAddress(2);
    const maker3 = userAddress(3);
    const maker4 = userAddress(4);
    const trader = userAddress(5);
    const entryPrice = BigInt.fromI32(3000000);
    const exitPrice = BigInt.fromI32(3100000);
    const qty = BigInt.fromI32(1000000);

    const open1 = createOrderMatchedEvent(
      orderId(1), maker1, trader, entryPrice, qty,
      BigInt.zero(), BigInt.zero(),
      qty.neg(), qty, entryPrice, entryPrice,
    );
    open1.logIndex = BigInt.fromI32(1);
    open1.transaction.hash = orderId(100);
    handleOrderMatched(open1);
    const session1 = positionSessionId(open1.block.number, open1.logIndex, 0);

    const close1 = createOrderMatchedEvent(
      orderId(2), maker2, trader, exitPrice, qty.neg(),
      BigInt.zero(), BigInt.zero(),
      qty, BigInt.zero(), exitPrice, BigInt.zero(),
    );
    close1.logIndex = BigInt.fromI32(2);
    close1.transaction.hash = orderId(101);
    handleOrderMatched(close1);
    assert.fieldEquals(
      "Trade",
      tradeId(close1.transaction.hash, trader, session1).toHexString(),
      "cumulativeRealizedPnl",
      "100000",
    );

    const open2 = createOrderMatchedEvent(
      orderId(3), maker3, trader, entryPrice, qty,
      BigInt.zero(), BigInt.zero(),
      qty.neg(), qty, entryPrice, entryPrice,
    );
    open2.logIndex = BigInt.fromI32(3);
    open2.transaction.hash = orderId(102);
    handleOrderMatched(open2);
    const session2 = positionSessionId(open2.block.number, open2.logIndex, 0);
    assert.fieldEquals(
      "Trade",
      tradeId(open2.transaction.hash, trader, session2).toHexString(),
      "cumulativeRealizedPnl",
      "100000",
    );

    const close2 = createOrderMatchedEvent(
      orderId(4), maker4, trader, exitPrice, qty.neg(),
      BigInt.zero(), BigInt.zero(),
      qty, BigInt.zero(), exitPrice, BigInt.zero(),
    );
    close2.logIndex = BigInt.fromI32(4);
    close2.transaction.hash = orderId(103);
    handleOrderMatched(close2);
    assert.fieldEquals(
      "Trade",
      tradeId(close2.transaction.hash, trader, session2).toHexString(),
      "cumulativeRealizedPnl",
      "200000",
    );
    assert.fieldEquals("User", trader.toHexString(), "realizedPnl", "200000");
  });
});
