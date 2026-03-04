import { BigInt, Address, Bytes, dataSource, log } from "@graphprotocol/graph-ts";
import {
  Initialized,
  OrderCreated,
  OrderCancelled,
  OrderUpdated,
  OrderMatched,
  PositionLiquidated,
  CollateralAdded,
  CollateralRemoved,
  MatchFeeUpdated,
  MarginPercentUpdated,
  MaintenanceMarginPercentUpdated,
  LiquidationFeeUpdated,
  FundingUpdated,
  FundingSettled,
  FundingParametersUpdated,
  MinimumMarginPerOrderUpdated,
  BadDebt,
  PerpsSimple as PerpsContract,
} from "../generated/PerpsSimple/PerpsSimple";
import {
  Perps,
  User,
  Order,
  Trade,
  Fill,
  Liquidation,
  CollateralEvent,
  PriceLevel,
  FundingUpdate,
  FundingSettlement,
  BadDebtEvent,
  PositionSession,
} from "../generated/schema";
import { absBigInt, isSameSign, minBigInt } from "./lib";
import { createEventId, getPriceLevelId, positionSessionId } from "./ids";

// ============ Helper Functions ============

function getOrCreatePerps(): Perps {
  let perps = Perps.load(0);
  if (!perps) {
    perps = new Perps(0);
    perps.contractAddress = dataSource.address();
    perps.collateralToken = Bytes.empty();
    perps.priceOracle = Bytes.empty();
    perps.marginPercent = 0;
    perps.quantityDecimals = 0;
    perps.maintenanceMarginPercent = 0;
    perps.liquidationFee = BigInt.zero();
    perps.minimumPriceIncrement = BigInt.zero();
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
    loadPerpsFromContract(perps);
  }
  return perps;
}

function loadPerpsFromContract(perps: Perps): void {
  const contract = PerpsContract.bind(dataSource.address());

  const collateralToken = contract.try_collateralToken();
  if (!collateralToken.reverted) {
    perps.collateralToken = collateralToken.value;
  }

  const priceOracle = contract.try_priceOracle();
  if (!priceOracle.reverted) {
    perps.priceOracle = priceOracle.value;
  }

  const marginPercent = contract.try_marginPercent();
  if (!marginPercent.reverted) {
    perps.marginPercent = marginPercent.value;
  }

  const maintenanceMarginPercent = contract.try_maintenanceMarginPercent();
  if (!maintenanceMarginPercent.reverted) {
    perps.maintenanceMarginPercent = maintenanceMarginPercent.value;
  }

  const liquidationFee = contract.try_liquidationFee();
  if (!liquidationFee.reverted) {
    perps.liquidationFee = liquidationFee.value;
  }

  const minimumPriceIncrement = contract.try_minimumPriceIncrement();
  if (!minimumPriceIncrement.reverted) {
    perps.minimumPriceIncrement = minimumPriceIncrement.value;
  }

  const takerFeeBps = contract.try_takerFeeBps();
  if (!takerFeeBps.reverted) {
    perps.takerFeeBps = takerFeeBps.value;
  }

  const makerFeeBps = contract.try_makerFeeBps();
  if (!makerFeeBps.reverted) {
    perps.makerFeeBps = makerFeeBps.value;
  }

  const quantityDecimals = contract.try_QUANTITY_DECIMALS();
  if (!quantityDecimals.reverted) {
    perps.quantityDecimals = quantityDecimals.value;
  }

  const fundingRateMaxBps = contract.try_fundingRateMaxBps();
  if (!fundingRateMaxBps.reverted) {
    perps.fundingRateMaxBps = fundingRateMaxBps.value;
  }

  const fundingPeriod = contract.try_fundingPeriod();
  if (!fundingPeriod.reverted) {
    perps.fundingPeriod = fundingPeriod.value;
  }

  const cumulativeFundingPerUnit = contract.try_cumulativeFundingPerUnit();
  if (!cumulativeFundingPerUnit.reverted) {
    perps.cumulativeFundingPerUnit = cumulativeFundingPerUnit.value;
  }

  const lastFundingUpdateTime = contract.try_lastFundingUpdateTime();
  if (!lastFundingUpdateTime.reverted) {
    perps.lastFundingUpdateTime = lastFundingUpdateTime.value;
  }

  const minimumMarginPerOrder = contract.try_minimumMarginPerOrder();
  if (!minimumMarginPerOrder.reverted) {
    perps.minimumMarginPerOrder = minimumMarginPerOrder.value;
  }
}

function getOrCreateUser(address: Address, timestamp: BigInt): User {
  let user = User.load(address);
  if (!user) {
    user = new User(address);
    user.address = address;
    user.collateralBalance = BigInt.zero();
    user.totalDeposited = BigInt.zero();
    user.totalWithdrawn = BigInt.zero();
    user.netQuantity = BigInt.zero();
    user.aggregatedEntryPrice = BigInt.zero();
    user.currentPositionSessionId = "";
    user.orderCount = 0;
    user.activeOrderCount = 0;
    user.tradeCount = 0;
    user.realizedPnl = BigInt.zero();
    user.totalFundingPaid = BigInt.zero();
    user.totalFundingReceived = BigInt.zero();
    user.createdAt = timestamp;
    user.lastActivityAt = timestamp;

    // Update global user count
    const perps = getOrCreatePerps();
    perps.totalUsers++;
    perps.save();
  }
  return user;
}

function getOrCreatePriceLevel(price: BigInt, isBid: boolean): PriceLevel {
  const id = getPriceLevelId(price, isBid);
  let level = PriceLevel.load(id);
  if (!level) {
    level = new PriceLevel(id);
    level.price = price;
    level.isBid = isBid;
    level.totalQuantity = BigInt.zero();
    level.orderCount = 0;
  }
  return level;
}

// ============ Event Handlers ============

export function handleInitialized(event: Initialized): void {
  log.info("PerpsSimple initialized with version: {}", [event.params.version.toString()]);

  const perps = getOrCreatePerps();
  perps.initializedAt = event.block.timestamp;
  perps.lastUpdatedAt = event.block.timestamp;
  loadPerpsFromContract(perps);
  perps.save();
}

export function handleOrderCreated(event: OrderCreated): void {
  log.info("Order created: {} by {}", [
    event.params.orderId.toHexString(),
    event.params.participant.toHexString(),
  ]);

  const user = getOrCreateUser(event.params.participant, event.block.timestamp);
  const isBuy = event.params.quantity.gt(BigInt.zero());
  const absQuantity = absBigInt(event.params.quantity);

  // Create order
  const order = new Order(event.params.orderId);
  order.user = user.id;
  order.price = event.params.price;
  order.quantity = absQuantity;
  order.originalQuantity = absQuantity;
  order.isBuy = isBuy;
  order.status = "ACTIVE";
  order.filledQuantity = BigInt.zero();
  order.createdAt = event.block.timestamp;
  order.updatedAt = event.block.timestamp;
  order.blockNumber = event.block.number;
  order.transactionHash = event.transaction.hash;
  order.save();

  // Update user
  user.orderCount++;
  user.activeOrderCount++;
  user.lastActivityAt = event.block.timestamp;
  user.save();

  // Update price level
  const level = getOrCreatePriceLevel(event.params.price, isBuy);
  level.totalQuantity = level.totalQuantity.plus(absQuantity);
  level.orderCount++;
  level.save();

  // Update global stats
  const perps = getOrCreatePerps();
  perps.totalOrders++;
  perps.activeOrders++;
  perps.lastUpdatedAt = event.block.timestamp;
  perps.save();
}

export function handleOrderCancelled(event: OrderCancelled): void {
  log.info("Order cancelled: {} by {}", [
    event.params.orderId.toHexString(),
    event.params.participant.toHexString(),
  ]);

  const order = Order.load(event.params.orderId);
  if (!order) {
    log.warning("Order not found: {}", [event.params.orderId.toHexString()]);
    return;
  }

  // Update price level
  const level = getOrCreatePriceLevel(order.price, order.isBuy);
  level.totalQuantity = level.totalQuantity.minus(order.quantity);
  level.orderCount--;
  level.save();

  // Update order
  order.status = "CANCELLED";
  order.closedAt = event.block.timestamp;
  order.updatedAt = event.block.timestamp;
  order.save();

  // Update user
  const user = User.load(order.user);
  if (user) {
    user.activeOrderCount--;
    user.lastActivityAt = event.block.timestamp;
    user.save();
  }

  // Update global stats
  const perps = getOrCreatePerps();
  perps.activeOrders--;
  perps.lastUpdatedAt = event.block.timestamp;
  perps.save();
}

export function handleOrderUpdated(event: OrderUpdated): void {
  log.info("Order updated: {} with new quantity {}", [
    event.params.orderId.toHexString(),
    event.params.newQuantity.toString(),
  ]);

  const order = Order.load(event.params.orderId);
  if (!order) {
    log.warning("Order not found: {}", [event.params.orderId.toHexString()]);
    return;
  }

  const oldQuantity = order.quantity;
  const newQuantity = absBigInt(event.params.newQuantity);
  const quantityDiff = oldQuantity.minus(newQuantity);
  const isFilled = event.params.newQuantity.equals(BigInt.zero());

  // Update price level
  const level = getOrCreatePriceLevel(order.price, order.isBuy);
  level.totalQuantity = level.totalQuantity.minus(quantityDiff);
  if (isFilled) {
    level.orderCount--;
  }
  level.save();

  // Update order
  order.quantity = newQuantity;
  order.filledQuantity = order.originalQuantity.minus(newQuantity);
  order.updatedAt = event.block.timestamp;

  if (isFilled) {
    order.status = "FILLED";
    order.closedAt = event.block.timestamp;

    // Update user
    const user = User.load(order.user);
    if (user) {
      user.activeOrderCount--;
      user.lastActivityAt = event.block.timestamp;
      user.save();
    }

    // Update global stats
    const perps = getOrCreatePerps();
    perps.activeOrders--;
    perps.lastUpdatedAt = event.block.timestamp;
    perps.save();
  } else {
    order.status = "PARTIAL";
  }

  order.save();
}

export function handleOrderMatched(event: OrderMatched): void {
  log.info("Order matched: makerOrderId {} maker {} taker {} price {} takerQty {} makerFee {} takerFee {}", [
    event.params.makerOrderId.toHexString(),
    event.params.maker.toHexString(),
    event.params.taker.toHexString(),
    event.params.tradePrice.toString(),
    event.params.takerQuantity.toString(),
    event.params.makerFee.toString(),
    event.params.takerFee.toString(),
  ]);

  const tradePrice = event.params.tradePrice;
  const takerQty = event.params.takerQuantity;
  const absQuantity = absBigInt(takerQty);

  const makerUser = getOrCreateUser(event.params.maker, event.block.timestamp);
  const takerUser = getOrCreateUser(event.params.taker, event.block.timestamp);
  const perps = getOrCreatePerps();
  const quantityScale = BigInt.fromI32(10).pow(u8(perps.quantityDecimals));

  processUserMatch(
    takerUser, takerQty, tradePrice, event.params.takerFee,
    event.params.takerNetQtyAfter, event.params.takerEntryPriceAfter,
    makerUser.id, event.params.makerOrderId,
    event.transaction.hash, event.logIndex, event.block.number, event.block.timestamp,
    0, quantityScale,
  );
  processUserMatch(
    makerUser, takerQty.neg(), tradePrice, event.params.makerFee,
    event.params.makerNetQtyAfter, event.params.makerEntryPriceAfter,
    takerUser.id, event.params.makerOrderId,
    event.transaction.hash, event.logIndex, event.block.number, event.block.timestamp,
    1, quantityScale,
  );

  const volume = tradePrice.times(absQuantity).div(quantityScale);
  perps.totalTrades++;
  perps.totalVolume = perps.totalVolume.plus(volume);
  perps.lastUpdatedAt = event.block.timestamp;
  perps.save();
}

/** Load or create the per-user per-transaction Trade aggregate. */
function getOrCreateTrade(txHash: Bytes, userId: Bytes, positionSessionId: string, timestamp: BigInt, blockNumber: BigInt): Trade {
  const tradeId = txHash.concat(userId);
  let trade = Trade.load(tradeId);
  if (!trade) {
    trade = new Trade(tradeId);
    trade.user = userId;
    trade.positionSession = positionSessionId;
    trade.tradePrice = BigInt.zero();
    trade.tradeQuantity = BigInt.zero();
    trade.tradingFee = BigInt.zero();
    trade.realizedPnl = BigInt.zero();
    trade.netQuantityAfter = BigInt.zero();
    trade.aggregatedEntryPriceAfter = BigInt.zero();
    trade.fillCount = 0;
    trade.timestamp = timestamp;
    trade.blockNumber = blockNumber;
    trade.transactionHash = txHash;
  }
  trade.positionSession = positionSessionId;
  return trade;
}

/** Update the Trade aggregate with a new fill's data. */
function updateTradeAggregate(trade: Trade, fillPrice: BigInt, fillQty: BigInt, fee: BigInt, pnl: BigInt, netQtyAfter: BigInt, entryPriceAfter: BigInt): void {
  const zero = BigInt.zero();
  const absFillQty = absBigInt(fillQty);
  const oldAbsTotal = absBigInt(trade.tradeQuantity);
  const newAbsTotal = oldAbsTotal.plus(absFillQty);

  if (newAbsTotal.gt(zero)) {
    trade.tradePrice = trade.tradePrice
      .times(oldAbsTotal)
      .plus(fillPrice.times(absFillQty))
      .div(newAbsTotal);
  }

  trade.tradeQuantity = trade.tradeQuantity.plus(fillQty);
  trade.tradingFee = trade.tradingFee.plus(fee);
  trade.realizedPnl = trade.realizedPnl.plus(pnl);
  trade.netQuantityAfter = netQtyAfter;
  trade.aggregatedEntryPriceAfter = entryPriceAfter;
  trade.fillCount++;
}

/**
 * Process one user's side of a match: compute position state, manage sessions, create fills.
 * Called once for the buyer (+qty) and once for the seller (-qty).
 */
function processUserMatch(
  user: User,
  tradeQty: BigInt,
  tradePrice: BigInt,
  tradingFee: BigInt,
  newNetQuantity: BigInt,
  newEntryPrice: BigInt,
  counterpartyId: Bytes,
  makerOrderId: Bytes,
  txHash: Bytes,
  logIndex: BigInt,
  blockNumber: BigInt,
  timestamp: BigInt,
  sideIndex: i32,
  quantityScale: BigInt,
): void {
  const zero = BigInt.zero();
  const oldNetQuantity = user.netQuantity;
  const oldEntryPrice = user.aggregatedEntryPrice;

  const wasFlat = oldNetQuantity.equals(zero);
  const isNowFlat = newNetQuantity.equals(zero);
  const positionFlipped = !wasFlat && !isNowFlat && !isSameSign(oldNetQuantity, newNetQuantity);
  const isPositionClosed = isNowFlat || positionFlipped;
  const isPositionOpened = wasFlat || positionFlipped;

  let realizedPnl = zero;
  if (!wasFlat && !isSameSign(oldNetQuantity, tradeQty)) {
    const absOld = absBigInt(oldNetQuantity);
    const settledAbs = minBigInt(absOld, absBigInt(tradeQty));
    const priceDiff = tradePrice.minus(oldEntryPrice);
    const signedSettledQty = oldNetQuantity.gt(zero) ? settledAbs : settledAbs.neg();
    realizedPnl = priceDiff.times(signedSettledQty).div(quantityScale);
  }

  const baseTradeId = createEventId(txHash, logIndex);

  if (positionFlipped) {
    handleFlip(
      user, tradeQty, tradePrice, tradingFee, realizedPnl, newNetQuantity, newEntryPrice,
      oldNetQuantity, oldEntryPrice, counterpartyId, makerOrderId,
      baseTradeId, txHash, blockNumber, logIndex, timestamp, sideIndex,
    );
  } else {
    handleNonFlip(
      user, tradeQty, tradePrice, tradingFee, realizedPnl, newNetQuantity, newEntryPrice,
      oldNetQuantity, counterpartyId, makerOrderId,
      isPositionOpened, isPositionClosed,
      baseTradeId, txHash, blockNumber, logIndex, timestamp, sideIndex,
    );
  }

  user.netQuantity = newNetQuantity;
  user.aggregatedEntryPrice = newEntryPrice;
  user.lastActivityAt = timestamp;
  user.save();
}

/** Flip: close old session + create close trade, then open new session + create open trade. */
function handleFlip(
  user: User,
  tradeQty: BigInt,
  tradePrice: BigInt,
  tradingFee: BigInt,
  realizedPnl: BigInt,
  newNetQuantity: BigInt,
  newEntryPrice: BigInt,
  oldNetQuantity: BigInt,
  oldEntryPrice: BigInt,
  counterpartyId: Bytes,
  makerOrderId: Bytes,
  baseTradeId: Bytes,
  txHash: Bytes,
  blockNumber: BigInt,
  logIndex: BigInt,
  timestamp: BigInt,
  sideIndex: i32,
): void {
  const zero = BigInt.zero();
  const absOld = absBigInt(oldNetQuantity);

  // 1. Close old session
  if (user.currentPositionSessionId.length > 0) {
    const oldSession = PositionSession.load(user.currentPositionSessionId);
    if (oldSession) {
      const oldClosed = oldSession.closedQuantity;
      oldSession.closedQuantity = oldSession.closedQuantity.plus(absOld);
      oldSession.realizedPnl = oldSession.realizedPnl.plus(realizedPnl);
      if (oldSession.closedQuantity.gt(zero)) {
        oldSession.closePrice = oldSession.closePrice
          .times(oldClosed)
          .plus(tradePrice.times(absOld))
          .div(oldSession.closedQuantity);
      }
      if (!tradingFee.equals(zero)) {
        oldSession.tradingFees = oldSession.tradingFees.plus(tradingFee);
      }
      oldSession.status = "CLOSE";
      oldSession.lastTradeAt = timestamp;
      oldSession.save();

      const closeQty = tradeQty.gt(zero) ? absOld : absOld.neg();
      const trade = getOrCreateTrade(txHash, user.id, oldSession.id, timestamp, blockNumber);
      const closeFill = new Fill(baseTradeId.concatI32(sideIndex * 2));
      closeFill.trade = trade.id;
      closeFill.user = user.id;
      closeFill.counterparty = counterpartyId;
      closeFill.makerOrderId = makerOrderId;
      closeFill.positionSession = oldSession.id;
      closeFill.fillPrice = tradePrice;
      closeFill.fillQuantity = closeQty;
      closeFill.netQuantityAfter = zero;
      closeFill.aggregatedEntryPriceAfter = oldEntryPrice;
      closeFill.realizedPnl = realizedPnl;
      closeFill.tradingFee = tradingFee;
      closeFill.timestamp = timestamp;
      closeFill.blockNumber = blockNumber;
      closeFill.transactionHash = txHash;
      closeFill.save();
      updateTradeAggregate(trade, tradePrice, closeQty, tradingFee, realizedPnl, zero, oldEntryPrice);
      trade.save();
    }
  }

  user.realizedPnl = user.realizedPnl.plus(realizedPnl);

  // 2. Open new session
  const newSessionId = positionSessionId(blockNumber, logIndex.toI32() * 2 + sideIndex);
  const newSession = new PositionSession(newSessionId);
  newSession.status = "OPEN";
  newSession.user = user.id;
  newSession.entryPrice = newEntryPrice;
  newSession.closePrice = zero;
  newSession.closedQuantity = zero;
  newSession.realizedPnl = zero;
  newSession.maxQuantity = absBigInt(newNetQuantity);
  newSession.tradingFees = zero;
  newSession.fundingFees = zero;
  newSession.openedAt = timestamp;
  newSession.lastTradeAt = timestamp;
  newSession.save();

  user.currentPositionSessionId = newSessionId;

  const trade = getOrCreateTrade(txHash, user.id, newSessionId, timestamp, blockNumber);
  const openFill = new Fill(baseTradeId.concatI32(sideIndex * 2 + 1));
  openFill.trade = trade.id;
  openFill.user = user.id;
  openFill.counterparty = counterpartyId;
  openFill.makerOrderId = makerOrderId;
  openFill.positionSession = newSession.id;
  openFill.fillPrice = tradePrice;
  openFill.fillQuantity = newNetQuantity;
  openFill.netQuantityAfter = newNetQuantity;
  openFill.aggregatedEntryPriceAfter = newEntryPrice;
  openFill.realizedPnl = zero;
  openFill.tradingFee = zero;
  openFill.timestamp = timestamp;
  openFill.blockNumber = blockNumber;
  openFill.transactionHash = txHash;
  openFill.save();
  updateTradeAggregate(trade, tradePrice, newNetQuantity, zero, zero, newNetQuantity, newEntryPrice);
  trade.save();
  user.tradeCount++;
}

/** Non-flip: single session + single trade (open, scale-in, partial close, or full close). */
function handleNonFlip(
  user: User,
  tradeQty: BigInt,
  tradePrice: BigInt,
  tradingFee: BigInt,
  realizedPnl: BigInt,
  newNetQuantity: BigInt,
  newEntryPrice: BigInt,
  oldNetQuantity: BigInt,
  counterpartyId: Bytes,
  makerOrderId: Bytes,
  isPositionOpened: bool,
  isPositionClosed: bool,
  baseTradeId: Bytes,
  txHash: Bytes,
  blockNumber: BigInt,
  logIndex: BigInt,
  timestamp: BigInt,
  sideIndex: i32,
): void {
  const zero = BigInt.zero();
  let session: PositionSession;

  if (isPositionOpened) {
    const id = positionSessionId(blockNumber, logIndex.toI32() * 2 + sideIndex);
    session = new PositionSession(id);
    session.status = "OPEN";
    session.user = user.id;
    session.openedAt = timestamp;
    session.closePrice = zero;
    session.closedQuantity = zero;
    session.realizedPnl = zero;
    session.maxQuantity = zero;
    session.tradingFees = zero;
    session.fundingFees = zero;
    user.currentPositionSessionId = id;
  } else {
    const loaded = PositionSession.load(user.currentPositionSessionId);
    if (!loaded) {
      log.warning("Position session not found for user {} sessionId {}", [
        user.id.toHexString(),
        user.currentPositionSessionId,
      ]);
      return;
    }
    session = loaded;
  }

  session.entryPrice = newEntryPrice;
  session.lastTradeAt = timestamp;

  const absAfter = absBigInt(newNetQuantity);
  if (session.maxQuantity.lt(absAfter)) {
    session.maxQuantity = absAfter;
  }

  if (isPositionClosed) {
    session.status = "CLOSE";
    user.currentPositionSessionId = "";
  }

  if (!realizedPnl.equals(zero)) {
    const absTradeQty = absBigInt(tradeQty);
    const settledAbs = minBigInt(absBigInt(oldNetQuantity), absTradeQty);
    const oldClosed = session.closedQuantity;
    session.closedQuantity = session.closedQuantity.plus(settledAbs);
    session.realizedPnl = session.realizedPnl.plus(realizedPnl);
    if (session.closedQuantity.gt(zero)) {
      session.closePrice = session.closePrice
        .times(oldClosed)
        .plus(tradePrice.times(settledAbs))
        .div(session.closedQuantity);
    }
    user.realizedPnl = user.realizedPnl.plus(realizedPnl);
  }

  if (!tradingFee.equals(zero)) {
    session.tradingFees = session.tradingFees.plus(tradingFee);
  }

  session.save();

  const trade = getOrCreateTrade(txHash, user.id, session.id, timestamp, blockNumber);
  const fill = new Fill(baseTradeId.concatI32(sideIndex));
  fill.trade = trade.id;
  fill.user = user.id;
  fill.counterparty = counterpartyId;
  fill.makerOrderId = makerOrderId;
  fill.positionSession = session.id;
  fill.fillPrice = tradePrice;
  fill.fillQuantity = tradeQty;
  fill.netQuantityAfter = newNetQuantity;
  fill.aggregatedEntryPriceAfter = newEntryPrice;
  fill.realizedPnl = realizedPnl;
  fill.tradingFee = tradingFee;
  fill.timestamp = timestamp;
  fill.blockNumber = blockNumber;
  fill.transactionHash = txHash;
  fill.save();
  updateTradeAggregate(trade, tradePrice, tradeQty, tradingFee, realizedPnl, newNetQuantity, newEntryPrice);
  trade.save();
  user.tradeCount++;
}

export function handlePositionLiquidated(event: PositionLiquidated): void {
  log.info("Position liquidated: user {} liquidator {} size {} pnl {} fee {}", [
    event.params.user.toHexString(),
    event.params.liquidator.toHexString(),
    event.params.positionSize.toString(),
    event.params.pnl.toString(),
    event.params.liquidatorFee.toString(),
  ]);

  const user = getOrCreateUser(event.params.user, event.block.timestamp);
  const liquidator = getOrCreateUser(event.params.liquidator, event.block.timestamp);

  // Create liquidation record
  const liqId = createEventId(event.transaction.hash, event.logIndex);
  const liquidation = new Liquidation(liqId);
  liquidation.user = user.id;
  liquidation.liquidator = liquidator.id;
  liquidation.positionSize = event.params.positionSize;
  liquidation.pnl = event.params.pnl;
  liquidation.liquidatorFee = event.params.liquidatorFee;
  liquidation.timestamp = event.block.timestamp;
  liquidation.blockNumber = event.block.number;
  liquidation.transactionHash = event.transaction.hash;
  liquidation.save();

  // Update user - position is now closed; mark current session as CLOSE if any
  if (user.currentPositionSessionId.length > 0) {
    const session = PositionSession.load(user.currentPositionSessionId);
    if (session) {
      session.status = "CLOSE";
      session.lastTradeAt = event.block.timestamp;
      session.save();
    }
  }
  user.netQuantity = BigInt.zero();
  user.aggregatedEntryPrice = BigInt.zero();
  user.currentPositionSessionId = "";
  user.realizedPnl = user.realizedPnl.plus(event.params.pnl);
  user.lastActivityAt = event.block.timestamp;
  user.save();

  // Update liquidator
  liquidator.lastActivityAt = event.block.timestamp;
  liquidator.save();

  // Update global stats
  const perps = getOrCreatePerps();
  perps.totalLiquidations++;
  perps.lastUpdatedAt = event.block.timestamp;
  perps.save();
}

export function handleCollateralAdded(event: CollateralAdded): void {
  log.info("Collateral added: user {} amount {}", [
    event.params.user.toHexString(),
    event.params.amount.toString(),
  ]);

  const user = getOrCreateUser(event.params.user, event.block.timestamp);

  // Create collateral event
  const eventId = createEventId(event.transaction.hash, event.logIndex);
  const collateralEvent = new CollateralEvent(eventId);
  collateralEvent.user = user.id;
  collateralEvent.amount = event.params.amount;
  collateralEvent.isDeposit = true;
  collateralEvent.timestamp = event.block.timestamp;
  collateralEvent.blockNumber = event.block.number;
  collateralEvent.transactionHash = event.transaction.hash;
  collateralEvent.save();

  // Update user
  user.collateralBalance = user.collateralBalance.plus(event.params.amount);
  user.totalDeposited = user.totalDeposited.plus(event.params.amount);
  user.lastActivityAt = event.block.timestamp;
  user.save();
}

export function handleCollateralRemoved(event: CollateralRemoved): void {
  log.info("Collateral removed: user {} amount {}", [
    event.params.user.toHexString(),
    event.params.amount.toString(),
  ]);

  const user = getOrCreateUser(event.params.user, event.block.timestamp);

  // Create collateral event
  const eventId = createEventId(event.transaction.hash, event.logIndex);
  const collateralEvent = new CollateralEvent(eventId);
  collateralEvent.user = user.id;
  collateralEvent.amount = event.params.amount;
  collateralEvent.isDeposit = false;
  collateralEvent.timestamp = event.block.timestamp;
  collateralEvent.blockNumber = event.block.number;
  collateralEvent.transactionHash = event.transaction.hash;
  collateralEvent.save();

  // Update user
  user.collateralBalance = user.collateralBalance.minus(event.params.amount);
  user.totalWithdrawn = user.totalWithdrawn.plus(event.params.amount);
  user.lastActivityAt = event.block.timestamp;
  user.save();
}

// ============ Funding Event Handlers ============

export function handleFundingUpdated(event: FundingUpdated): void {
  log.info("Funding updated: rate {} cumulative {} time {}", [
    event.params.fundingRate.toString(),
    event.params.cumulativeFundingPerUnit.toString(),
    event.params.timestamp.toString(),
  ]);

  const eventId = createEventId(event.transaction.hash, event.logIndex);
  const fundingUpdate = new FundingUpdate(eventId);
  fundingUpdate.fundingRate = event.params.fundingRate;
  fundingUpdate.cumulativeFundingPerUnit = event.params.cumulativeFundingPerUnit;
  fundingUpdate.timestamp = event.params.timestamp;
  fundingUpdate.blockNumber = event.block.number;
  fundingUpdate.transactionHash = event.transaction.hash;
  fundingUpdate.save();

  const perps = getOrCreatePerps();
  perps.cumulativeFundingPerUnit = event.params.cumulativeFundingPerUnit;
  perps.lastFundingUpdateTime = event.params.timestamp;
  perps.lastUpdatedAt = event.block.timestamp;
  perps.save();
}

export function handleFundingSettled(event: FundingSettled): void {
  log.info("Funding settled: user {} amount {}", [
    event.params.user.toHexString(),
    event.params.amount.toString(),
  ]);

  const user = getOrCreateUser(event.params.user, event.block.timestamp);

  const eventId = createEventId(event.transaction.hash, event.logIndex);
  const settlement = new FundingSettlement(eventId);
  settlement.user = user.id;
  settlement.amount = event.params.amount;
  settlement.timestamp = event.block.timestamp;
  settlement.blockNumber = event.block.number;
  settlement.transactionHash = event.transaction.hash;

  if (user.currentPositionSessionId.length > 0) {
    const session = PositionSession.load(user.currentPositionSessionId);
    if (session) {
      settlement.positionSession = session.id;
      session.fundingFees = session.fundingFees.plus(event.params.amount);
      session.save();
    }
  }

  settlement.save();

  if (event.params.amount.gt(BigInt.zero())) {
    user.totalFundingReceived = user.totalFundingReceived.plus(event.params.amount);
  } else {
    user.totalFundingPaid = user.totalFundingPaid.plus(event.params.amount.neg());
  }
  user.lastActivityAt = event.block.timestamp;
  user.save();
}

export function handleBadDebt(event: BadDebt): void {
  log.info("Bad debt: user {} amount {}", [
    event.params.user.toHexString(),
    event.params.amount.toString(),
  ]);

  const user = getOrCreateUser(event.params.user, event.block.timestamp);

  const eventId = createEventId(event.transaction.hash, event.logIndex);
  const badDebtEvent = new BadDebtEvent(eventId);
  badDebtEvent.user = user.id;
  badDebtEvent.amount = event.params.amount;
  badDebtEvent.timestamp = event.block.timestamp;
  badDebtEvent.blockNumber = event.block.number;
  badDebtEvent.transactionHash = event.transaction.hash;
  badDebtEvent.save();

  const perps = getOrCreatePerps();
  perps.totalBadDebt = perps.totalBadDebt.plus(event.params.amount);
  perps.lastUpdatedAt = event.block.timestamp;
  perps.save();
}

// ============ Config Event Handlers ============

export function handleMatchFeeUpdated(event: MatchFeeUpdated): void {
  log.info("Match fee updated: taker {} maker {}", [
    event.params.newTakerFeeBps.toString(),
    event.params.newMakerFeeBps.toString(),
  ]);
  const perps = getOrCreatePerps();
  perps.takerFeeBps = event.params.newTakerFeeBps;
  perps.makerFeeBps = event.params.newMakerFeeBps;
  perps.lastUpdatedAt = event.block.timestamp;
  perps.save();
}

export function handleMarginPercentUpdated(event: MarginPercentUpdated): void {
  log.info("Margin percent updated: {}", [event.params.newMarginPercent.toString()]);
  const perps = getOrCreatePerps();
  perps.marginPercent = event.params.newMarginPercent;
  perps.lastUpdatedAt = event.block.timestamp;
  perps.save();
}

export function handleMaintenanceMarginPercentUpdated(
  event: MaintenanceMarginPercentUpdated,
): void {
  log.info("Maintenance margin percent updated: {}", [
    event.params.newMaintenanceMarginPercent.toString(),
  ]);
  const perps = getOrCreatePerps();
  perps.maintenanceMarginPercent = event.params.newMaintenanceMarginPercent;
  perps.lastUpdatedAt = event.block.timestamp;
  perps.save();
}

export function handleLiquidationFeeUpdated(event: LiquidationFeeUpdated): void {
  log.info("Liquidation fee updated: {}", [event.params.newLiquidationFee.toString()]);
  const perps = getOrCreatePerps();
  perps.liquidationFee = event.params.newLiquidationFee;
  perps.lastUpdatedAt = event.block.timestamp;
  perps.save();
}

export function handleFundingParametersUpdated(event: FundingParametersUpdated): void {
  log.info("Funding parameters updated: maxBps {} period {}", [
    event.params.maxBps.toString(),
    event.params.period.toString(),
  ]);
  const perps = getOrCreatePerps();
  perps.fundingRateMaxBps = event.params.maxBps;
  perps.fundingPeriod = event.params.period;
  perps.lastUpdatedAt = event.block.timestamp;
  perps.save();
}

export function handleMinimumMarginPerOrderUpdated(event: MinimumMarginPerOrderUpdated): void {
  log.info("Minimum margin per order updated: {}", [
    event.params.newMinimumMarginPerOrder.toString(),
  ]);
  const perps = getOrCreatePerps();
  perps.minimumMarginPerOrder = event.params.newMinimumMarginPerOrder;
  perps.lastUpdatedAt = event.block.timestamp;
  perps.save();
}
