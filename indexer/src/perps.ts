import { BigInt, Address, Bytes, dataSource, log } from "@graphprotocol/graph-ts";
import {
  Initialized,
  OrderCreated,
  OrderFilled,
  OrderCancelled,
  OrderUpdated,
  OrderMatched,
  PositionTrade,
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
  Liquidation,
  CollateralEvent,
  PriceLevel,
  FundingUpdate,
  FundingSettlement,
  BadDebtEvent,
  PositionSession,
} from "../generated/schema";
import { isSameSign } from "./lib";
import { createEventId, positionSessionId } from "./ids";

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

function abs(value: BigInt): BigInt {
  return value.lt(BigInt.zero()) ? value.neg() : value;
}

function getPriceLevelId(price: BigInt, isBid: boolean): string {
  return price.toString() + "-" + (isBid ? "bid" : "ask");
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
  const absQuantity = abs(event.params.quantity);

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

export function handleOrderFilled(event: OrderFilled): void {
  log.info("Order filled: {} by {}", [
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
  order.status = "FILLED";
  order.filledQuantity = order.originalQuantity;
  order.quantity = BigInt.zero();
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
  const newQuantity = abs(event.params.newQuantity);
  const quantityDiff = oldQuantity.minus(newQuantity);

  // Update price level
  const level = getOrCreatePriceLevel(order.price, order.isBuy);
  level.totalQuantity = level.totalQuantity.minus(quantityDiff);
  level.save();

  // Update order
  order.quantity = newQuantity;
  order.filledQuantity = order.originalQuantity.minus(newQuantity);
  order.status = "PARTIAL";
  order.updatedAt = event.block.timestamp;
  order.save();
}

export function handleOrderMatched(event: OrderMatched): void {
  log.info("Order matched: makerOrderId {} buyer {} seller {} price {} qty {}", [
    event.params.makerOrderId.toHexString(),
    event.params.buyer.toHexString(),
    event.params.seller.toHexString(),
    event.params.price.toString(),
    event.params.quantity.toString(),
  ]);

  const buyer = getOrCreateUser(event.params.buyer, event.block.timestamp);
  const seller = getOrCreateUser(event.params.seller, event.block.timestamp);
  const perps = getOrCreatePerps();

  const quantityScale = BigInt.fromI32(10).pow(u8(perps.quantityDecimals));
  const volume = event.params.price.times(event.params.quantity).div(quantityScale);

  buyer.lastActivityAt = event.block.timestamp;
  buyer.save();
  seller.lastActivityAt = event.block.timestamp;
  seller.save();

  perps.totalTrades++;
  perps.totalVolume = perps.totalVolume.plus(volume);
  perps.lastUpdatedAt = event.block.timestamp;
  perps.save();
}

export function handlePositionTrade(event: PositionTrade): void {
  log.info("Position trade: user {} price {} qty {} netAfter {} entryAfter {} realizedPnl {}", [
    event.params.user.toHexString(),
    event.params.tradePrice.toString(),
    event.params.quantity.toString(),
    event.params.netQuantityAfter.toString(),
    event.params.aggregatedEntryPriceAfter.toString(),
    event.params.realizedPnl.toString(),
  ]);

  const user = getOrCreateUser(event.params.user, event.block.timestamp);
  const netQuantityBefore = event.params.netQuantityAfter.minus(event.params.quantity);
  const netQuantityAfter = event.params.netQuantityAfter;
  const positionFlipped = !isSameSign(netQuantityBefore, netQuantityAfter);
  const isPositionClosed = netQuantityAfter.equals(BigInt.zero()) || positionFlipped;
  const isPositionOpened = positionFlipped;

  let session: PositionSession;
  if (isPositionOpened) {
    const id = positionSessionId(event.block.number, event.logIndex.toI32());
    session = new PositionSession(id);
    session.status = "OPEN";
    session.user = user.id;
    session.entryPrice = event.params.aggregatedEntryPriceAfter;
    session.closePrice = BigInt.zero();
    session.maxQuantity = abs(event.params.netQuantityAfter);
    session.closedQuantity = BigInt.zero();
    session.realizedPnl = BigInt.zero();
    session.fundingFees = BigInt.zero();
    session.tradingFees = BigInt.zero();
    session.openedAt = event.block.timestamp;
    session.lastTradeAt = event.block.timestamp;
    session.save();
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

  session.lastTradeAt = event.block.timestamp;
  const absAfter = abs(netQuantityAfter);
  if (session.maxQuantity.lt(absAfter)) {
    session.maxQuantity = absAfter;
  }

  if (isPositionClosed) {
    session.status = "CLOSE";
    user.currentPositionSessionId = "";
  }

  if (!event.params.realizedPnl.equals(BigInt.zero())) {
    const absQty = abs(event.params.quantity);
    const oldClosed = session.closedQuantity;
    session.closedQuantity = session.closedQuantity.plus(absQty);
    session.realizedPnl = session.realizedPnl.plus(event.params.realizedPnl);
    // Weighted average exit price: totalNotional / totalClosedQuantity
    if (session.closedQuantity.gt(BigInt.zero())) {
      session.closePrice = session.closePrice
        .times(oldClosed)
        .plus(event.params.tradePrice.times(absQty))
        .div(session.closedQuantity);
    }
    user.realizedPnl = user.realizedPnl.plus(event.params.realizedPnl);
  }

  session.save();

  // Every trade is linked to its PositionSession (same session we created or loaded above)
  const tradeId = createEventId(event.transaction.hash, event.logIndex);
  const trade = new Trade(tradeId);
  trade.user = user.id;
  trade.positionSession = session.id; // links Trade → PositionSession; positionSession.trades is @derivedFrom
  trade.tradePrice = event.params.tradePrice;
  trade.tradeQuantity = event.params.quantity;
  trade.netQuantityAfter = event.params.netQuantityAfter;
  trade.aggregatedEntryPriceAfter = event.params.aggregatedEntryPriceAfter;
  trade.realizedPnl = event.params.realizedPnl;
  trade.timestamp = event.block.timestamp;
  trade.blockNumber = event.block.number;
  trade.transactionHash = event.transaction.hash;
  trade.save();

  user.tradeCount++;

  user.netQuantity = event.params.netQuantityAfter;
  user.aggregatedEntryPrice = event.params.aggregatedEntryPriceAfter;
  user.lastActivityAt = event.block.timestamp;
  user.save();
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
