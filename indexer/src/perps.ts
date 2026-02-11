import { BigInt, Address, Bytes, dataSource, log } from "@graphprotocol/graph-ts";
import {
  Initialized,
  OrderCreated,
  OrderFilled,
  OrderCancelled,
  OrderUpdated,
  OrderMatched,
  PositionTrade,
  PositionClosed,
  PositionLiquidated,
  CollateralAdded,
  CollateralRemoved,
  MatchFeeUpdated,
  MarginPercentUpdated,
  MaintenanceMarginPercentUpdated,
  LiquidationFeeUpdated,
  PerpsSimple as PerpsContract,
} from "../generated/PerpsSimple/PerpsSimple";
import {
  Perps,
  User,
  Order,
  Trade,
  PositionSnapshot,
  PositionClose,
  Liquidation,
  CollateralEvent,
  PriceLevel,
} from "../generated/schema";

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
    perps.reservePoolBalance = BigInt.zero();
    perps.collectedFeesBalance = BigInt.zero();
    perps.totalUsers = 0;
    perps.totalOrders = 0;
    perps.activeOrders = 0;
    perps.totalTrades = 0;
    perps.totalVolume = BigInt.zero();
    perps.totalLiquidations = 0;
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
    user.orderCount = 0;
    user.activeOrderCount = 0;
    user.tradeCount = 0;
    user.realizedPnl = BigInt.zero();
    user.trades = [];
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

function createEventId(transactionHash: Bytes, logIndex: BigInt): Bytes {
  return transactionHash.concatI32(logIndex.toI32());
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
  log.info("Order matched: maker {} buyer {} seller {} price {} qty {}", [
    event.params.makerOrderId.toHexString(),
    event.params.buyer.toHexString(),
    event.params.seller.toHexString(),
    event.params.price.toString(),
    event.params.quantity.toString(),
  ]);

  const buyer = getOrCreateUser(event.params.buyer, event.block.timestamp);
  const seller = getOrCreateUser(event.params.seller, event.block.timestamp);

  const volume = event.params.price.times(event.params.quantity);

  // Create trade
  const tradeId = createEventId(event.transaction.hash, event.logIndex);
  const trade = new Trade(tradeId);
  trade.makerOrderId = event.params.makerOrderId;
  trade.buyer = buyer.id;
  trade.seller = seller.id;
  trade.price = event.params.price;
  trade.quantity = event.params.quantity;
  trade.volume = volume;
  trade.timestamp = event.block.timestamp;
  trade.blockNumber = event.block.number;
  trade.transactionHash = event.transaction.hash;
  trade.save();

  // Update users - add trade to both buyer and seller
  buyer.trades = buyer.trades.concat([trade.id]);
  buyer.tradeCount++;
  buyer.lastActivityAt = event.block.timestamp;
  buyer.save();

  seller.trades = seller.trades.concat([trade.id]);
  seller.tradeCount++;
  seller.lastActivityAt = event.block.timestamp;
  seller.save();

  // Update global stats
  const perps = getOrCreatePerps();
  perps.totalTrades++;
  perps.totalVolume = perps.totalVolume.plus(volume);
  perps.lastUpdatedAt = event.block.timestamp;
  perps.save();
}

export function handlePositionTrade(event: PositionTrade): void {
  log.info("Position trade: user {} price {} qty {} netAfter {} entryAfter {}", [
    event.params.user.toHexString(),
    event.params.tradePrice.toString(),
    event.params.quantity.toString(),
    event.params.netQuantityAfter.toString(),
    event.params.aggregatedEntryPriceAfter.toString(),
  ]);

  const user = getOrCreateUser(event.params.user, event.block.timestamp);

  // Create position snapshot
  const snapshotId = createEventId(event.transaction.hash, event.logIndex);
  const snapshot = new PositionSnapshot(snapshotId);
  snapshot.user = user.id;
  snapshot.tradePrice = event.params.tradePrice;
  snapshot.tradeQuantity = event.params.quantity;
  snapshot.netQuantityAfter = event.params.netQuantityAfter;
  snapshot.aggregatedEntryPriceAfter = event.params.aggregatedEntryPriceAfter;
  snapshot.timestamp = event.block.timestamp;
  snapshot.blockNumber = event.block.number;
  snapshot.transactionHash = event.transaction.hash;
  snapshot.save();

  // Update user's current position
  user.netQuantity = event.params.netQuantityAfter;
  user.aggregatedEntryPrice = event.params.aggregatedEntryPriceAfter;
  user.lastActivityAt = event.block.timestamp;
  user.save();
}

export function handlePositionClosed(event: PositionClosed): void {
  log.info("Position closed: user {} qty {} pnl {}", [
    event.params.user.toHexString(),
    event.params.quantityClosed.toString(),
    event.params.pnl.toString(),
  ]);

  const user = getOrCreateUser(event.params.user, event.block.timestamp);

  // Create position close record
  const closeId = createEventId(event.transaction.hash, event.logIndex);
  const close = new PositionClose(closeId);
  close.user = user.id;
  close.quantityClosed = event.params.quantityClosed;
  close.pnl = event.params.pnl;
  close.timestamp = event.block.timestamp;
  close.blockNumber = event.block.number;
  close.transactionHash = event.transaction.hash;
  close.save();

  // Update user's realized PnL
  user.realizedPnl = user.realizedPnl.plus(event.params.pnl);
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

  // Update user - position is now closed
  user.netQuantity = BigInt.zero();
  user.aggregatedEntryPrice = BigInt.zero();
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
