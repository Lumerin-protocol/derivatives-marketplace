import {
  BigInt,
  Address,
  Bytes,
  dataSource,
  log,
} from "@graphprotocol/graph-ts";
import {
  Initialized,
  OrderCreated,
  OrderCancelled,
  OrderLiquidated,
  OrderUpdated,
  OrderMatched,
  PositionLiquidated,
  MatchFeeUpdated,
  MarginPercentUpdated,
  MaintenanceMarginPercentUpdated,
  LiquidationFeeUpdated,
  FundingUpdated,
  FundingSettled,
  FundingParametersUpdated,
  MinimumMarginPerOrderUpdated,
  BadDebt,
  HashPowerPerpsDEX as PerpsContract,
} from "../generated/HashPowerPerpsDEX/HashPowerPerpsDEX";
import {
  Perps,
  User,
  Order,
  Trade,
  Fill,
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
    perps.collateralVault = Bytes.empty();
    perps.portfolioMarginEngine = Bytes.empty();
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

  const makerFeeBps = contract.try_makerFeeBps();
  if (!makerFeeBps.reverted) {
    perps.makerFeeBps = makerFeeBps.value;
  }

  const takerFeeBps = contract.try_takerFeeBps();
  if (!takerFeeBps.reverted) {
    perps.takerFeeBps = takerFeeBps.value;
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

  const vault = contract.try_vault();
  if (!vault.reverted) {
    perps.collateralVault = vault.value;
  }

  const portfolioMargin = contract.try_portfolioMargin();
  if (!portfolioMargin.reverted) {
    perps.portfolioMarginEngine = portfolioMargin.value;
  }
}

function getOrCreateUser(address: Address, timestamp: BigInt): User {
  let user = User.load(address);
  if (!user) {
    user = new User(address);
    user.address = address;
    user.netQuantity = BigInt.zero();
    user.aggregatedEntryPrice = BigInt.zero();
    user.currentPositionSessionId = "";
    user.orderCount = 0;
    user.activeOrderCount = 0;
    user.tradeCount = 0;
    user.realizedPnl = BigInt.zero();
    user.totalFundingPaid = BigInt.zero();
    user.totalFundingReceived = BigInt.zero();
    user.lastCreatedOrderId = Bytes.empty();
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
  log.info("HashPowerPerpsDEX initialized with version: {}", [
    event.params.version.toString(),
  ]);

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
  order.averageFillPrice = BigInt.zero();
  order.createdAt = event.block.timestamp;
  order.updatedAt = event.block.timestamp;
  order.blockNumber = event.block.number;
  order.transactionHash = event.transaction.hash;
  order.save();

  // Update user
  user.orderCount++;
  user.activeOrderCount++;
  // Remember this orderId so handleOrderMatched can attribute taker-side fills to it
  // (OrderMatched only carries makerOrderId; the taker's OrderCreated always fires first).
  user.lastCreatedOrderId = event.params.orderId;
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

  // `liquidateOrder` co-emits OrderCancelled + OrderLiquidated in one tx. Either
  // log order must end at LIQUIDATED, so a cancel must never downgrade an order
  // already flagged liquidated (and must not double-decrement book/user/global
  // counters, which handleOrderLiquidated already adjusted on the cancel leg).
  if (order.status == "LIQUIDATED") {
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

export function handleOrderLiquidated(event: OrderLiquidated): void {
  log.info("Order liquidated: {} user {} by {}", [
    event.params.orderId.toHexString(),
    event.params.user.toHexString(),
    event.params.liquidator.toHexString(),
  ]);

  const order = Order.load(event.params.orderId);
  if (!order) {
    log.warning("Order not found: {}", [event.params.orderId.toHexString()]);
    return;
  }

  // `liquidateOrder` co-emits OrderCancelled + OrderLiquidated in the same tx
  // (OrderCancelled first on-chain). LIQUIDATED is the terminal state and must
  // win regardless of log order, while the book/user/global counters are
  // decremented exactly once. So only do the book cleanup here if the order is
  // still open (i.e. OrderLiquidated was processed before its paired
  // OrderCancelled); otherwise the cancel leg already did it. The paired
  // OrderCancelled is guarded to skip once status == LIQUIDATED.
  const alreadyClosed =
    order.status == "CANCELLED" ||
    order.status == "FILLED" ||
    order.status == "LIQUIDATED";
  if (!alreadyClosed) {
    const level = getOrCreatePriceLevel(order.price, order.isBuy);
    level.totalQuantity = level.totalQuantity.minus(order.quantity);
    level.orderCount--;
    level.save();

    const user = User.load(order.user);
    if (user) {
      user.activeOrderCount--;
      user.lastActivityAt = event.block.timestamp;
      user.save();
    }

    const perps = getOrCreatePerps();
    perps.activeOrders--;
    perps.lastUpdatedAt = event.block.timestamp;
    perps.save();
  }

  order.status = "LIQUIDATED";
  order.liquidator = event.params.liquidator;
  order.liquidationFee = event.params.fee;
  order.closedAt = event.block.timestamp;
  order.updatedAt = event.block.timestamp;
  order.save();
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
  log.info(
    "Order matched: makerOrderId {} maker {} taker {} price {} takerQty {} makerFee {} takerFee {}",
    [
      event.params.makerOrderId.toHexString(),
      event.params.maker.toHexString(),
      event.params.taker.toHexString(),
      event.params.tradePrice.toString(),
      event.params.takerQuantity.toString(),
      event.params.makerFee.toString(),
      event.params.takerFee.toString(),
    ],
  );

  const tradePrice = event.params.tradePrice;
  const takerQty = event.params.takerQuantity;
  const absQuantity = absBigInt(takerQty);

  const makerUser = getOrCreateUser(event.params.maker, event.block.timestamp);
  const takerUser = getOrCreateUser(event.params.taker, event.block.timestamp);
  const perps = getOrCreatePerps();
  const quantityScale = BigInt.fromI32(10).pow(u8(perps.quantityDecimals));

  const makerOid = event.params.makerOrderId;
  const takerOid = takerUser.lastCreatedOrderId;

  processUserMatch(
    takerUser,
    takerQty,
    tradePrice,
    event.params.takerFee,
    event.params.takerNetQtyAfter,
    event.params.takerEntryPriceAfter,
    makerUser.id,
    takerOid,
    makerOid,
    "TAKER",
    event.transaction.hash,
    event.logIndex,
    event.block.number,
    event.block.timestamp,
    0,
    quantityScale,
  );
  processUserMatch(
    makerUser,
    takerQty.neg(),
    tradePrice,
    event.params.makerFee,
    event.params.makerNetQtyAfter,
    event.params.makerEntryPriceAfter,
    takerUser.id,
    makerOid,
    takerOid,
    "MAKER",
    event.transaction.hash,
    event.logIndex,
    event.block.number,
    event.block.timestamp,
    1,
    quantityScale,
  );

  const volume = tradePrice.times(absQuantity).div(quantityScale);
  perps.totalTrades++;
  perps.totalVolume = perps.totalVolume.plus(volume);
  perps.lastUpdatedAt = event.block.timestamp;
  perps.save();
}

/** Load or create the per-user per-transaction Trade aggregate. */
function getOrCreateTrade(
  txHash: Bytes,
  userId: Bytes,
  positionSessionId: string,
  timestamp: BigInt,
  blockNumber: BigInt,
): Trade {
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
    trade.isLiquidation = false;
    trade.timestamp = timestamp;
    trade.blockNumber = blockNumber;
    trade.transactionHash = txHash;
  }
  trade.positionSession = positionSessionId;
  return trade;
}

/** Update the Trade aggregate with a new fill's data. */
function updateTradeAggregate(
  trade: Trade,
  fillPrice: BigInt,
  fillQty: BigInt,
  fee: BigInt,
  pnl: BigInt,
  netQtyAfter: BigInt,
  entryPriceAfter: BigInt,
): void {
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
  userOrderId: Bytes,
  counterpartyOrderId: Bytes,
  side: string,
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
  const positionFlipped =
    !wasFlat && !isNowFlat && !isSameSign(oldNetQuantity, newNetQuantity);
  const isPositionClosed = isNowFlat || positionFlipped;
  const isPositionOpened = wasFlat || positionFlipped;

  let realizedPnl = zero;
  if (!wasFlat && !isSameSign(oldNetQuantity, tradeQty)) {
    const absOld = absBigInt(oldNetQuantity);
    const settledAbs = minBigInt(absOld, absBigInt(tradeQty));
    const priceDiff = tradePrice.minus(oldEntryPrice);
    const signedSettledQty = oldNetQuantity.gt(zero)
      ? settledAbs
      : settledAbs.neg();
    realizedPnl = priceDiff.times(signedSettledQty).div(quantityScale);
  }

  const baseTradeId = createEventId(txHash, logIndex);

  if (positionFlipped) {
    handleFlip(
      user,
      tradeQty,
      tradePrice,
      tradingFee,
      realizedPnl,
      newNetQuantity,
      newEntryPrice,
      oldNetQuantity,
      oldEntryPrice,
      counterpartyId,
      userOrderId,
      counterpartyOrderId,
      side,
      baseTradeId,
      txHash,
      blockNumber,
      logIndex,
      timestamp,
      sideIndex,
    );
  } else {
    handleNonFlip(
      user,
      tradeQty,
      tradePrice,
      tradingFee,
      realizedPnl,
      newNetQuantity,
      newEntryPrice,
      oldNetQuantity,
      counterpartyId,
      userOrderId,
      counterpartyOrderId,
      side,
      isPositionOpened,
      isPositionClosed,
      baseTradeId,
      txHash,
      blockNumber,
      logIndex,
      timestamp,
      sideIndex,
    );
  }

  updateOrderFillStats(userOrderId, tradePrice, absBigInt(tradeQty));

  user.netQuantity = newNetQuantity;
  user.aggregatedEntryPrice = newEntryPrice;
  user.lastActivityAt = timestamp;
  user.save();
}

/** Update an order's running averageFillPrice (VWAP) and filledQuantity from one match. */
function updateOrderFillStats(
  orderId: Bytes,
  fillPrice: BigInt,
  absFillQty: BigInt,
): void {
  const order = Order.load(orderId);
  if (!order) {
    log.warning("Order not found for fill stats update: {}", [
      orderId.toHexString(),
    ]);
    return;
  }
  const oldFilled = order.filledQuantity;
  const newFilled = oldFilled.plus(absFillQty);
  if (newFilled.gt(BigInt.zero())) {
    order.averageFillPrice = order.averageFillPrice
      .times(oldFilled)
      .plus(fillPrice.times(absFillQty))
      .div(newFilled);
  }
  // Track filledQuantity incrementally here so it stays correct even before
  // OrderUpdated arrives (taker-side OrderUpdated fires once after all matches).
  order.filledQuantity = newFilled;
  order.save();
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
  userOrderId: Bytes,
  counterpartyOrderId: Bytes,
  side: string,
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
      const trade = getOrCreateTrade(
        txHash,
        user.id,
        oldSession.id,
        timestamp,
        blockNumber,
      );
      const closeFill = new Fill(baseTradeId.concatI32(sideIndex * 2));
      closeFill.trade = trade.id;
      closeFill.side = side;
      closeFill.user = user.id;
      closeFill.counterparty = counterpartyId;
      closeFill.order = userOrderId;
      closeFill.counterpartyOrder = counterpartyOrderId;
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
      updateTradeAggregate(
        trade,
        tradePrice,
        closeQty,
        tradingFee,
        realizedPnl,
        zero,
        oldEntryPrice,
      );
      trade.save();
    }
  }

  user.realizedPnl = user.realizedPnl.plus(realizedPnl);

  // 2. Open new session
  const newSessionId = positionSessionId(
    blockNumber,
    logIndex.toI32() * 2 + sideIndex,
  );
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
  newSession.liquidatedQuantity = zero;
  newSession.openedAt = timestamp;
  newSession.lastTradeAt = timestamp;
  newSession.save();

  user.currentPositionSessionId = newSessionId;

  const trade = getOrCreateTrade(
    txHash,
    user.id,
    newSessionId,
    timestamp,
    blockNumber,
  );
  const openFill = new Fill(baseTradeId.concatI32(sideIndex * 2 + 1));
  openFill.trade = trade.id;
  openFill.side = side;
  openFill.user = user.id;
  openFill.counterparty = counterpartyId;
  openFill.order = userOrderId;
  openFill.counterpartyOrder = counterpartyOrderId;
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
  updateTradeAggregate(
    trade,
    tradePrice,
    newNetQuantity,
    zero,
    zero,
    newNetQuantity,
    newEntryPrice,
  );
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
  userOrderId: Bytes,
  counterpartyOrderId: Bytes,
  side: string,
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
    // Always initialize entryPrice for newly created sessions.
    // This also covers flat-to-flat/self-match flows where the session
    // is opened and closed within the same event.
    session.entryPrice = newEntryPrice;
    session.openedAt = timestamp;
    session.closePrice = zero;
    session.closedQuantity = zero;
    session.realizedPnl = zero;
    session.maxQuantity = zero;
    session.tradingFees = zero;
    session.fundingFees = zero;
    session.liquidatedQuantity = zero;
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

  // On full close the contract emits newEntryPrice = 0; preserve the historical entry price
  // so the closed session still reflects what the position was opened/scaled at.
  if (!isPositionClosed) {
    session.entryPrice = newEntryPrice;
  }
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

  const trade = getOrCreateTrade(
    txHash,
    user.id,
    session.id,
    timestamp,
    blockNumber,
  );
  const fill = new Fill(baseTradeId.concatI32(sideIndex));
  fill.trade = trade.id;
  fill.side = side;
  fill.user = user.id;
  fill.counterparty = counterpartyId;
  fill.order = userOrderId;
  fill.counterpartyOrder = counterpartyOrderId;
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
  updateTradeAggregate(
    trade,
    tradePrice,
    tradeQty,
    tradingFee,
    realizedPnl,
    newNetQuantity,
    newEntryPrice,
  );
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
  const liquidator = getOrCreateUser(
    event.params.liquidator,
    event.block.timestamp,
  );
  const perps = getOrCreatePerps();
  const quantityScale = BigInt.fromI32(10).pow(u8(perps.quantityDecimals));

  const zero = BigInt.zero();
  const positionSize = event.params.positionSize; // signed closed position
  const pnl = event.params.pnl;
  const liquidatorFee = event.params.liquidatorFee;

  // Capture entry price + open session BEFORE they are zeroed/cleared below;
  // the forced exit price and the Trade.positionSession link both need them.
  const entryPrice = user.aggregatedEntryPrice;
  const closingSessionId = user.currentPositionSessionId;

  // Derive the forced exit price from the realized PnL the event reports:
  //   pnl = (exit - entry) * positionSize / scale
  //   => exit = entry + pnl * scale / positionSize
  let exitPrice = entryPrice;
  if (!positionSize.equals(zero)) {
    exitPrice = entryPrice.plus(pnl.times(quantityScale).div(positionSize));
  }

  // The forced trade offsets the closed position, so its signed quantity is the
  // opposite sign of the closed position size (short close → forced buy → +).
  const closedQty = positionSize.neg();
  const absClosed = absBigInt(positionSize);

  // The dedicated Liquidation entity was dropped: the flagged liquidation Trade
  // below is the single source of truth (it captures positionSize -> signed
  // tradeQuantity, pnl -> realizedPnl, liquidatorFee -> liquidationFee, the
  // liquidator, and tx/time). `Perps.totalLiquidations` + `BadDebtEvent` stay.

  // Close the open session with full close stats + denormalized
  // liquidatedQuantity, and create the forced liquidation Trade linked to it
  // (the flagged Trade is the single source of truth for the Trades feed).
  if (closingSessionId.length > 0) {
    const session = PositionSession.load(closingSessionId);
    if (session) {
      const oldClosed = session.closedQuantity;
      session.closedQuantity = oldClosed.plus(absClosed);
      session.realizedPnl = session.realizedPnl.plus(pnl);
      if (session.closedQuantity.gt(zero)) {
        session.closePrice = session.closePrice
          .times(oldClosed)
          .plus(exitPrice.times(absClosed))
          .div(session.closedQuantity);
      }
      session.liquidatedQuantity = session.liquidatedQuantity.plus(absClosed);
      session.status = "CLOSE";
      session.lastTradeAt = event.block.timestamp;
      session.save();

      const trade = getOrCreateTrade(
        event.transaction.hash,
        user.id,
        session.id,
        event.block.timestamp,
        event.block.number,
      );
      trade.tradePrice = exitPrice;
      trade.tradeQuantity = closedQty;
      trade.tradingFee = zero;
      trade.realizedPnl = pnl;
      trade.netQuantityAfter = zero;
      trade.aggregatedEntryPriceAfter = zero;
      // No per-counterparty Fill: a perps liquidation is a forced close against
      // the insurance fund, so there is no matched order to anchor a Fill to.
      trade.fillCount = 0;
      trade.isLiquidation = true;
      trade.liquidator = event.params.liquidator;
      trade.liquidationFee = liquidatorFee;
      trade.save();

      user.tradeCount++;
      perps.totalTrades++;
    }
  }

  // Reset user position state (position is now fully closed).
  user.netQuantity = zero;
  user.aggregatedEntryPrice = zero;
  user.currentPositionSessionId = "";
  user.realizedPnl = user.realizedPnl.plus(pnl);
  user.lastActivityAt = event.block.timestamp;
  user.save();

  liquidator.lastActivityAt = event.block.timestamp;
  liquidator.save();

  perps.totalLiquidations++;
  perps.lastUpdatedAt = event.block.timestamp;
  perps.save();
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
  fundingUpdate.cumulativeFundingPerUnit =
    event.params.cumulativeFundingPerUnit;
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
    user.totalFundingReceived = user.totalFundingReceived.plus(
      event.params.amount,
    );
  } else {
    user.totalFundingPaid = user.totalFundingPaid.plus(
      event.params.amount.neg(),
    );
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
  log.info("Margin percent updated: {}", [
    event.params.newMarginPercent.toString(),
  ]);
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

export function handleLiquidationFeeUpdated(
  event: LiquidationFeeUpdated,
): void {
  log.info("Liquidation fee updated: {}", [
    event.params.newLiquidationFee.toString(),
  ]);
  const perps = getOrCreatePerps();
  perps.liquidationFee = event.params.newLiquidationFee;
  perps.lastUpdatedAt = event.block.timestamp;
  perps.save();
}

export function handleFundingParametersUpdated(
  event: FundingParametersUpdated,
): void {
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

export function handleMinimumMarginPerOrderUpdated(
  event: MinimumMarginPerOrderUpdated,
): void {
  log.info("Minimum margin per order updated: {}", [
    event.params.newMinimumMarginPerOrder.toString(),
  ]);
  const perps = getOrCreatePerps();
  perps.minimumMarginPerOrder = event.params.newMinimumMarginPerOrder;
  perps.lastUpdatedAt = event.block.timestamp;
  perps.save();
}
