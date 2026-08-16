import {
  BigInt,
  Address,
  Bytes,
  dataSource,
  log,
} from "@graphprotocol/graph-ts";
import {
  Initialized,
  Upgraded,
  OrderCreated,
  OrderCancelled,
  OrderLiquidated,
  OrderUpdated,
  OrderMatched,
  PositionLiquidated,
  MakerFeeBpsUpdated,
  TakerFeeBpsUpdated,
  LiquidationFeeBpsUpdated,
  LiquidatorShareBpsUpdated,
  OracleUpdated,
  PortfolioMarginUpdated,
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
  LiquidationTx,
  PositionSession,
} from "../generated/schema";
import { absBigInt, isSameSign, minBigInt } from "./lib";
import {
  closeOrder,
  isTerminalOrderStatus,
  syncCancelledQuantity,
} from "./orders";
import {
  createEventId,
  fillId,
  getPriceLevelId,
  positionSessionId,
  tradeId,
} from "./ids";

// ============ Deferred Perps-singleton counters ============
// `Trade` / `Fill` rows are minted deep inside the per-leg helpers, which have
// no handle on the `Perps` singleton. Rather than reading + writing the
// singleton per leg, the helpers accumulate row counts here and the surrounding
// handler flushes them alongside its own `Perps` updates.
let pendingNewTrades: i32 = 0;
let pendingNewFills: i32 = 0;

/**
 * Fold pending Trade/Fill row counts onto an in-memory `Perps` singleton and
 * reset them. The caller owns the `save()`.
 */
function flushPerpsCounters(perps: Perps): void {
  if (pendingNewTrades != 0) {
    perps.totalTrades += pendingNewTrades;
    pendingNewTrades = 0;
  }
  if (pendingNewFills != 0) {
    perps.totalFills += pendingNewFills;
    pendingNewFills = 0;
  }
}

// ============ Helper Functions ============

function getOrCreatePerps(): Perps {
  let perps = Perps.load(0);
  if (!perps) {
    perps = new Perps(0);
    perps.contractAddress = dataSource.address();
    perps.priceOracle = Bytes.empty();
    perps.collateralVault = Bytes.empty();
    perps.portfolioMargin = Bytes.empty();
    perps.startBlock = readStartBlockFromContext();
    perps.quantityDecimals = 0;
    perps.minimumPriceIncrement = BigInt.zero();
    perps.liquidationFeeBps = 0;
    perps.liquidatorShareBps = 0;
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
    perps.totalFills = 0;
    perps.totalVolume = BigInt.zero();
    perps.totalLiquidations = 0;
    perps.totalLiquidatedValue = BigInt.zero();
    perps.totalBadDebt = BigInt.zero();
    perps.initializedAt = BigInt.zero();
    perps.lastUpdatedAt = BigInt.zero();
    loadPerpsFromContract(perps);
  }
  return perps;
}

/**
 * Pull the configured start block from the data source context (set in
 * `subgraph.template.yaml` from the `PERPS_START_BLOCK` env var).
 * Returns zero if the context entry is absent (e.g. matchstick tests).
 */
function readStartBlockFromContext(): BigInt {
  const ctx = dataSource.context();
  const value = ctx.get("startBlock");
  if (value == null) return BigInt.zero();
  return value.toBigInt();
}

function loadPerpsFromContract(perps: Perps): void {
  const contract = PerpsContract.bind(dataSource.address());

  const priceOracle = contract.try_priceOracle();
  if (!priceOracle.reverted) {
    perps.priceOracle = priceOracle.value;
  }

  const liquidationFeeBps = contract.try_liquidationFeeBps();
  if (!liquidationFeeBps.reverted) {
    perps.liquidationFeeBps = liquidationFeeBps.value;
  }

  const liquidatorShareBps = contract.try_liquidatorShareBps();
  if (!liquidatorShareBps.reverted) {
    perps.liquidatorShareBps = liquidatorShareBps.value;
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
    perps.portfolioMargin = portfolioMargin.value;
  }
}

/**
 * Idempotent per-tx marker used by `handleOrderLiquidated` /
 * `handlePositionLiquidated` to bump `Perps.totalLiquidations` exactly once per
 * tx. Returns true iff this invocation created the marker (i.e. it's the first
 * leg seen in this tx); subsequent legs in the same tx return false and the
 * caller skips the counter increment.
 */
function markLiquidationTx(txHash: Bytes): boolean {
  if (LiquidationTx.load(txHash) != null) return false;
  const marker = new LiquidationTx(txHash);
  marker.save();
  return true;
}

function getOrCreateUser(address: Address, timestamp: BigInt): User {
  let user = User.load(address);
  if (!user) {
    user = new User(address);
    user.address = address;
    user.netQuantity = BigInt.zero();
    user.aggregatedEntryPrice = BigInt.zero();
    user.currentSessionId = "";
    user.orderCount = 0;
    user.activeOrderCount = 0;
    user.tradeCount = 0;
    user.fillCount = 0;
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

export function handleUpgraded(event: Upgraded): void {
  log.info("HashPowerPerpsDEX upgraded to {}", [
    event.params.implementation.toHexString(),
  ]);

  // A new implementation can change any of the config getters, so re-read the
  // whole snapshot rather than waiting for individual setter events.
  const perps = getOrCreatePerps();
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
  order.cancelledQuantity = BigInt.zero();
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

  closeOrder(order, "CANCELLED", event.block.timestamp, event.transaction.from);
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
  const alreadyClosed = isTerminalOrderStatus(order.status);
  const perps = getOrCreatePerps();
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

    perps.activeOrders--;
  }

  // One keeper tx can liquidate many order and position legs; the sentinel
  // makes the counter tick once for the whole tx.
  if (markLiquidationTx(event.transaction.hash)) {
    perps.totalLiquidations++;
  }
  perps.lastUpdatedAt = event.block.timestamp;
  perps.save();

  closeOrder(order, "LIQUIDATED", event.block.timestamp, event.transaction.from);
  order.liquidator = event.params.liquidator;
  order.liquidationFee = event.params.fee;
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
  const isClosed = event.params.newQuantity.equals(BigInt.zero());

  // Update price level (book always follows remaining size).
  const level = getOrCreatePriceLevel(order.price, order.isBuy);
  level.totalQuantity = level.totalQuantity.minus(quantityDiff);
  if (isClosed) {
    level.orderCount--;
  }
  level.save();

  // Remaining size only. `filledQuantity` is owned by `OrderMatched` /
  // `updateOrderFillStats` so a lone shrink (reduce-only amend) is not a fill.
  order.quantity = newQuantity;
  order.updatedAt = event.block.timestamp;

  if (isClosed) {
    // Full fill or IOC close (amend never emits newQuantity=0 — use
    // cancelOrder). The maker's OrderUpdated is emitted *before* its
    // OrderMatched, so a full fill still looks unmatched here;
    // `updateOrderFillStats` upgrades CANCELLED to FILLED right after.
    const status = order.filledQuantity.gt(BigInt.zero())
      ? "FILLED"
      : "CANCELLED";
    closeOrder(order, status, event.block.timestamp, event.transaction.from);

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
  } else {
    // A shrink that did not match is cancelled size, so re-derive it here.
    syncCancelledQuantity(order);
    order.status = order.filledQuantity.gt(BigInt.zero())
      ? "PARTIALLY_FILLED"
      : // Reduce-only amend (or pre-match book update): still ACTIVE.
        "ACTIVE";
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
  // Re-load the maker: on a self-match both legs mutate the same `User` row, so
  // the maker leg has to start from the counters the taker leg just wrote.
  processUserMatch(
    getOrCreateUser(event.params.maker, event.block.timestamp),
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
  flushPerpsCounters(perps);
  perps.totalVolume = perps.totalVolume.plus(volume);
  perps.lastUpdatedAt = event.block.timestamp;
  perps.save();
}

/**
 * Load or create the per-(tx, user, position session) Trade aggregate.
 *
 * The session is part of the id so that a tx spanning two sessions (a flip
 * closes one and opens another) produces one row per session instead of
 * collapsing both legs — which would leak the closed session's realized PnL
 * into the freshly-opened one.
 *
 * Bumps `user.tradeCount` and the deferred `Perps.totalTrades` delta when it
 * mints a row; the caller owns `user.save()`.
 */
function getOrCreateTrade(
  txHash: Bytes,
  user: User,
  sessionId: string,
  timestamp: BigInt,
  blockNumber: BigInt,
): Trade {
  const id = tradeId(txHash, user.id, sessionId);
  let trade = Trade.load(id);
  if (!trade) {
    trade = new Trade(id);
    trade.user = user.id;
    trade.positionSession = sessionId;
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

    user.tradeCount++;
    pendingNewTrades += 1;
  }
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
      txHash,
      blockNumber,
      logIndex,
      timestamp,
      sideIndex,
    );
  }

  updateOrderFillStats(userOrderId, tradePrice, absBigInt(tradeQty), timestamp);

  user.netQuantity = newNetQuantity;
  user.aggregatedEntryPrice = newEntryPrice;
  user.lastActivityAt = timestamp;
  user.save();
}

/**
 * Credit one match against an order: running averageFillPrice (VWAP),
 * filledQuantity, and the derived status. Called for BOTH sides of every
 * OrderMatched — the maker order id comes off the event, the taker's off
 * `User.lastCreatedOrderId`.
 *
 * `_executeMatch` emits the maker's OrderUpdated *before* OrderMatched, so the
 * status that handler derived was based on a stale `filledQuantity`: a fully
 * filled maker was provisionally closed as CANCELLED and is upgraded to FILLED
 * here, and a partially filled one moves from ACTIVE to PARTIALLY_FILLED.
 */
function updateOrderFillStats(
  orderId: Bytes,
  fillPrice: BigInt,
  absFillQty: BigInt,
  timestamp: BigInt,
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
  order.updatedAt = timestamp;
  syncCancelledQuantity(order);

  // A keeper owns the close attribution; the fill only moves the counters.
  if (order.status != "LIQUIDATED") {
    if (order.quantity.equals(BigInt.zero())) {
      order.status = "FILLED";
      order.closedAt = timestamp;
    } else {
      order.status = "PARTIALLY_FILLED";
    }
  }
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
  txHash: Bytes,
  blockNumber: BigInt,
  logIndex: BigInt,
  timestamp: BigInt,
  sideIndex: i32,
): void {
  const zero = BigInt.zero();
  const absOld = absBigInt(oldNetQuantity);

  // 1. Close old session
  if (user.currentSessionId.length > 0) {
    const oldSession = PositionSession.load(user.currentSessionId);
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
      oldSession.netQuantity = zero;
      oldSession.lastTradeAt = timestamp;
      oldSession.save();

      const closeQty = tradeQty.gt(zero) ? absOld : absOld.neg();
      const trade = getOrCreateTrade(
        txHash,
        user,
        oldSession.id,
        timestamp,
        blockNumber,
      );
      const closeFill = new Fill(fillId(txHash, logIndex, sideIndex));
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
      user.fillCount++;
      pendingNewFills += 1;
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
  const newSessionId = positionSessionId(blockNumber, logIndex, sideIndex);
  const newSession = new PositionSession(newSessionId);
  newSession.status = "OPEN";
  newSession.user = user.id;
  newSession.entryPrice = newEntryPrice;
  newSession.closePrice = zero;
  newSession.netQuantity = newNetQuantity;
  newSession.closedQuantity = zero;
  newSession.realizedPnl = zero;
  newSession.maxQuantity = absBigInt(newNetQuantity);
  newSession.tradingFees = zero;
  newSession.fundingFees = zero;
  newSession.liquidatedQuantity = zero;
  newSession.openedAt = timestamp;
  newSession.lastTradeAt = timestamp;
  newSession.save();

  user.currentSessionId = newSessionId;

  const trade = getOrCreateTrade(
    txHash,
    user,
    newSessionId,
    timestamp,
    blockNumber,
  );
  // `sideIndex + 2` keeps the re-opening leg's id disjoint from the leg the
  // other side of the same log writes at `sideIndex`.
  const openFill = new Fill(fillId(txHash, logIndex, sideIndex + 2));
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
  user.fillCount++;
  pendingNewFills += 1;
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
  txHash: Bytes,
  blockNumber: BigInt,
  logIndex: BigInt,
  timestamp: BigInt,
  sideIndex: i32,
): void {
  const zero = BigInt.zero();
  let session: PositionSession;

  if (isPositionOpened) {
    const id = positionSessionId(blockNumber, logIndex, sideIndex);
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
    user.currentSessionId = id;
  } else {
    const loaded = PositionSession.load(user.currentSessionId);
    if (!loaded) {
      log.warning("Position session not found for user {} sessionId {}", [
        user.id.toHexString(),
        user.currentSessionId,
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
  // Covers the open branch too, so the new session never rests at zero. A full
  // close reports newNetQuantity = 0, which is the value the CLOSE row wants.
  session.netQuantity = newNetQuantity;

  const absAfter = absBigInt(newNetQuantity);
  if (session.maxQuantity.lt(absAfter)) {
    session.maxQuantity = absAfter;
  }

  if (isPositionClosed) {
    session.status = "CLOSE";
    user.currentSessionId = "";
  }

  // Any leg opposing the running position settles size, whether or not it
  // happened to break even — so gate on the settled quantity, not on the PnL.
  if (!oldNetQuantity.equals(zero) && !isSameSign(oldNetQuantity, tradeQty)) {
    const settledAbs = minBigInt(
      absBigInt(oldNetQuantity),
      absBigInt(tradeQty),
    );
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
    user,
    session.id,
    timestamp,
    blockNumber,
  );
  const fill = new Fill(fillId(txHash, logIndex, sideIndex));
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
  user.fillCount++;
  pendingNewFills += 1;
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
}

export function handlePositionLiquidated(event: PositionLiquidated): void {
  log.info("Position liquidated: user {} liquidator {} closed {} pnl {} fee {}", [
    event.params.user.toHexString(),
    event.params.liquidator.toHexString(),
    event.params.closedQuantity.toString(),
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
  const closedQuantity = event.params.closedQuantity; // signed closed quantity
  const pnl = event.params.pnl;
  const liquidatorFee = event.params.liquidatorFee;

  // Capture entry price + open session BEFORE they are zeroed/cleared below;
  // the forced exit price and the Trade.positionSession link both need them.
  const entryPrice = user.aggregatedEntryPrice;
  const closingSessionId = user.currentSessionId;

  // Derive the forced exit price from the realized PnL the event reports:
  //   pnl = (exit - entry) * closedQuantity / scale
  //   => exit = entry + pnl * scale / closedQuantity
  let exitPrice = entryPrice;
  if (!closedQuantity.equals(zero)) {
    exitPrice = entryPrice.plus(pnl.times(quantityScale).div(closedQuantity));
  }

  // The forced trade offsets the closed position, so its signed quantity is the
  // opposite sign of the closed quantity (short close → forced buy → +).
  const closedQty = closedQuantity.neg();
  const absClosed = absBigInt(closedQuantity);

  // `closedQuantity` carries the SAME sign as the position, so the residual
  // after a (possibly partial) close is `net - closedQuantity`. A partial close
  // leaves a non-zero residual: keep the position + session open and only
  // reduce; a full close (residual == 0) resets the user and closes the session.
  const newNetQuantity = user.netQuantity.minus(closedQuantity);
  const isFullClose = newNetQuantity.equals(zero);

  // The dedicated Liquidation entity was dropped: the flagged liquidation Trade
  // below is the single source of truth (it captures closedQuantity -> signed
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
      // Partial close leaves the session open to keep accruing the residual.
      session.status = isFullClose ? "CLOSE" : "OPEN";
      session.netQuantity = newNetQuantity;
      session.lastTradeAt = event.block.timestamp;
      session.save();

      const trade = getOrCreateTrade(
        event.transaction.hash,
        user,
        session.id,
        event.block.timestamp,
        event.block.number,
      );
      trade.tradePrice = exitPrice;
      trade.tradeQuantity = closedQty;
      trade.tradingFee = zero;
      trade.realizedPnl = pnl;
      // Residual position after the close (0 on a full close). A reducing close
      // leaves the aggregated entry price unchanged.
      trade.netQuantityAfter = newNetQuantity;
      trade.aggregatedEntryPriceAfter = isFullClose ? zero : entryPrice;
      // No per-counterparty Fill: a perps liquidation is a forced close against
      // the insurance fund, so there is no matched order to anchor a Fill to.
      trade.fillCount = 0;
      trade.isLiquidation = true;
      trade.liquidator = event.params.liquidator;
      trade.liquidationFee = liquidatorFee;
      trade.save();
    }
  }

  // Update user position state. Full close → reset; partial close → reduce
  // netQuantity toward zero, preserving the (unchanged) entry price and the
  // open session link so the residual keeps flowing into the same session.
  if (isFullClose) {
    user.netQuantity = zero;
    user.aggregatedEntryPrice = zero;
    user.currentSessionId = "";
  } else {
    user.netQuantity = newNetQuantity;
    // aggregatedEntryPrice unchanged (reducing close doesn't re-average);
    // currentSessionId stays pointed at the open session.
  }
  user.realizedPnl = user.realizedPnl.plus(pnl);
  user.lastActivityAt = event.block.timestamp;
  user.save();

  liquidator.lastActivityAt = event.block.timestamp;
  liquidator.save();

  flushPerpsCounters(perps);
  if (markLiquidationTx(event.transaction.hash)) {
    perps.totalLiquidations++;
  }
  // Per position leg, not per tx: same scaling as totalVolume so the two are
  // directly comparable.
  perps.totalLiquidatedValue = perps.totalLiquidatedValue.plus(
    exitPrice.times(absClosed).div(quantityScale),
  );
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

  if (user.currentSessionId.length > 0) {
    const session = PositionSession.load(user.currentSessionId);
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

export function handleMakerFeeBpsUpdated(event: MakerFeeBpsUpdated): void {
  log.info("Maker fee bps updated: {}", [
    event.params.newMakerFeeBps.toString(),
  ]);
  const perps = getOrCreatePerps();
  perps.makerFeeBps = event.params.newMakerFeeBps;
  perps.lastUpdatedAt = event.block.timestamp;
  perps.save();
}

export function handleTakerFeeBpsUpdated(event: TakerFeeBpsUpdated): void {
  log.info("Taker fee bps updated: {}", [
    event.params.newTakerFeeBps.toString(),
  ]);
  const perps = getOrCreatePerps();
  perps.takerFeeBps = event.params.newTakerFeeBps;
  perps.lastUpdatedAt = event.block.timestamp;
  perps.save();
}

export function handleLiquidationFeeBpsUpdated(
  event: LiquidationFeeBpsUpdated,
): void {
  log.info("Liquidation fee bps updated: {}", [
    event.params.newLiquidationFeeBps.toString(),
  ]);
  const perps = getOrCreatePerps();
  perps.liquidationFeeBps = event.params.newLiquidationFeeBps;
  perps.lastUpdatedAt = event.block.timestamp;
  perps.save();
}

export function handleLiquidatorShareBpsUpdated(
  event: LiquidatorShareBpsUpdated,
): void {
  log.info("Liquidator share bps updated: {}", [
    event.params.newLiquidatorShareBps.toString(),
  ]);
  const perps = getOrCreatePerps();
  perps.liquidatorShareBps = event.params.newLiquidatorShareBps;
  perps.lastUpdatedAt = event.block.timestamp;
  perps.save();
}

export function handleOracleUpdated(event: OracleUpdated): void {
  log.info("Oracle updated: {}", [
    event.params.newOracle.toHexString(),
  ]);
  const perps = getOrCreatePerps();
  perps.priceOracle = event.params.newOracle;
  perps.lastUpdatedAt = event.block.timestamp;
  perps.save();
}

export function handlePortfolioMarginUpdated(event: PortfolioMarginUpdated): void {
  log.info("Portfolio margin updated: {}", [
    event.params.newPortfolioMargin.toHexString(),
  ]);
  const perps = getOrCreatePerps();
  perps.portfolioMargin = event.params.newPortfolioMargin;
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
