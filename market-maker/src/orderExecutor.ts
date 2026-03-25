import { type PublicClient, type WalletClient, type Account, type Chain, encodeFunctionData } from "viem";
import type { MakerConfig } from "./config.ts";
import type { Quoter, DesiredQuotes, QuoteLevel } from "./quoter.ts";
import type { BookTracker, OwnOrder } from "./bookTracker.ts";
import type { GasTracker } from "./gasTracker.ts";
import type { RiskManager } from "./riskManager.ts";
import type { OracleTracker } from "./oracleTracker.ts";
import type pino from "pino";
import { hashPowerPerpsDexAbi } from "./abi.ts";
import { bigAbs } from "./math.ts";

export class OrderExecutor {
  readonly stats = { ordersPlaced: 0, ordersCancelled: 0, reconcileCount: 0 };

  private lastRequoteAt = 0;
  private lastQuoteMidPrice = 0n;

  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly account: Account;
  private readonly chain: Chain;
  private readonly config: MakerConfig;
  private readonly quoter: Quoter;
  private readonly book: BookTracker;
  private readonly gas: GasTracker;
  private readonly risk: RiskManager;
  private readonly oracle: OracleTracker;
  private readonly logger: pino.Logger;

  constructor(
    publicClient: PublicClient,
    walletClient: WalletClient,
    account: Account,
    chain: Chain,
    config: MakerConfig,
    quoter: Quoter,
    book: BookTracker,
    gas: GasTracker,
    risk: RiskManager,
    oracle: OracleTracker,
    logger: pino.Logger,
  ) {
    this.publicClient = publicClient;
    this.walletClient = walletClient;
    this.account = account;
    this.chain = chain;
    this.config = config;
    this.quoter = quoter;
    this.book = book;
    this.gas = gas;
    this.risk = risk;
    this.oracle = oracle;
    this.logger = logger.child({ component: "executor" });
  }

  /** Main reconcile loop: diff desired quotes vs current orders, cancel/place as needed. */
  async reconcile(desired: DesiredQuotes): Promise<void> {
    if (!this.shouldRequote(desired)) {
      this.logger.debug("requote skipped (within threshold or cooldown)");
      return;
    }

    if (this.gas.isGasSpiking) {
      const drift = this.priceDriftTicks();
      if (drift < this.config.urgentRequoteThresholdTicks) {
        this.logger.info(
          { drift, threshold: this.config.urgentRequoteThresholdTicks, gasSpike: this.gas.gasSpikePct.toFixed(0) },
          "requote skipped: gas spike, drift below urgent threshold",
        );
        return;
      }
      this.logger.warn({ drift }, "proceeding with requote despite gas spike (urgent drift)");
    }

    const ordersToCancel = this.findStaleOrders(desired);
    const ordersToPlace = this.findNewOrders(desired);

    if (ordersToCancel.length === 0 && ordersToPlace.length === 0) {
      this.logger.debug("no order changes needed");
      return;
    }

    const maxFeePerGas = this.gas.cappedGasPrice();

    const calls: `0x${string}`[] = [];

    for (const order of ordersToCancel) {
      calls.push(encodeFunctionData({ abi: hashPowerPerpsDexAbi, functionName: "cancelOrder", args: [order.orderId] }));
    }
    for (const level of ordersToPlace) {
      calls.push(encodeFunctionData({ abi: hashPowerPerpsDexAbi, functionName: "createOrder", args: [level.price, level.quantity] }));
    }

    if (this.config.dryRun) {
      this.logger.info(
        { cancels: ordersToCancel.length, places: ordersToPlace.length },
        "DRY RUN: would send multicall batch",
      );
      return;
    }

    try {
      const hash = await this.walletClient.writeContract({
        address: this.config.perpsAddress,
        abi: hashPowerPerpsDexAbi,
        functionName: "multicall",
        args: [calls],
        account: this.account,
        chain: this.chain,
        maxFeePerGas,
      });

      const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
      const gasCost = this.computeTxGasCost(receipt);
      this.risk.recordGasCost(gasCost);

      this.stats.ordersCancelled += ordersToCancel.length;
      this.stats.ordersPlaced += ordersToPlace.length;

      this.logger.info(
        { cancels: ordersToCancel.length, places: ordersToPlace.length, gas: receipt.gasUsed.toString() },
        "multicall batch executed",
      );
    } catch (err) {
      this.logger.error(
        { cancels: ordersToCancel.length, places: ordersToPlace.length, err },
        "multicall batch failed",
      );
      throw err;
    }

    this.lastRequoteAt = Date.now();
    this.lastQuoteMidPrice = this.oracle.currentPrice;
    this.stats.reconcileCount++;
  }

  /** Cancel all MM orders (used by circuit breaker). */
  async cancelAll(): Promise<void> {
    const orders = [...this.book.ownOrders.values()];
    if (orders.length === 0) return;

    this.logger.warn({ count: orders.length }, "cancelling all orders");
    const maxFeePerGas = this.gas.cappedGasPrice();

    const calls = orders.map((order) =>
      encodeFunctionData({ abi: hashPowerPerpsDexAbi, functionName: "cancelOrder", args: [order.orderId] }),
    );

    if (this.config.dryRun) {
      this.logger.info({ count: orders.length }, "DRY RUN: would cancel all orders via multicall");
      return;
    }

    try {
      const hash = await this.walletClient.writeContract({
        address: this.config.perpsAddress,
        abi: hashPowerPerpsDexAbi,
        functionName: "multicall",
        args: [calls],
        account: this.account,
        chain: this.chain,
        maxFeePerGas,
      });

      const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
      const gasCost = this.computeTxGasCost(receipt);
      this.risk.recordGasCost(gasCost);

      this.stats.ordersCancelled += orders.length;
      this.logger.info({ count: orders.length, gas: receipt.gasUsed.toString() }, "all orders cancelled via multicall");
    } catch (err) {
      this.logger.error({ count: orders.length, err }, "cancel-all multicall failed");
      throw err;
    }
  }

  private shouldRequote(desired: DesiredQuotes): boolean {
    // Cooldown check
    if (Date.now() - this.lastRequoteAt < this.effectiveCooldownMs()) {
      return false;
    }

    // If fewer orders resting than desired (e.g. after a full fill), requote to refill
    const expectedCount = desired.bids.length + desired.asks.length;
    if (this.book.ownOrders.size < expectedCount) {
      return true;
    }

    // If any price level has less quantity than desired (partial fill), top up
    if (this.hasQuantityDeficit(desired)) {
      return true;
    }

    // Price drift check
    const drift = this.priceDriftTicks();
    return drift >= this.effectiveRequoteThreshold();
  }

  private priceDriftTicks(): number {
    if (this.lastQuoteMidPrice === 0n) return Infinity;
    const tick = this.quoter.getTick();
    if (tick === 0n) return 0;
    const diff = bigAbs(this.oracle.currentPrice - this.lastQuoteMidPrice);
    return Number(diff / tick);
  }

  /** Dynamic cooldown: increase when gas budget is throttled. */
  private effectiveCooldownMs(): number {
    let cooldown = this.config.requoteCooldownMs;
    if (this.risk.throttled) {
      cooldown *= 3;
    }
    return cooldown;
  }

  /** Dynamic requote threshold: widen when gas budget is throttled. */
  private effectiveRequoteThreshold(): number {
    let threshold = this.config.requoteThresholdTicks;
    if (this.risk.throttled) {
      threshold *= 2;
    }
    return threshold;
  }

  /**
   * Find existing orders that don't match any desired level (should be cancelled).
   * An order is "matching" if its price equals a desired level's price.
   */
  private findStaleOrders(desired: DesiredQuotes): OwnOrder[] {
    const desiredPrices = new Set<bigint>();
    for (const b of desired.bids) desiredPrices.add(b.price);
    for (const a of desired.asks) desiredPrices.add(a.price);

    const stale: OwnOrder[] = [];
    for (const order of this.book.ownOrders.values()) {
      if (!desiredPrices.has(order.price)) {
        stale.push(order);
      }
    }
    return stale;
  }

  /**
   * Find desired levels that need new orders placed.
   * For levels with no existing order, places the full desired quantity.
   * For partially filled levels, places a top-up order for the deficit.
   */
  private findNewOrders(desired: DesiredQuotes): QuoteLevel[] {
    const existingQtyByPrice = this.aggregateOwnQuantityByPrice();

    const toPlace: QuoteLevel[] = [];
    for (const b of desired.bids) {
      const existing = existingQtyByPrice.get(b.price) ?? 0n;
      const deficit = b.quantity - existing;
      if (deficit > 0n) {
        toPlace.push({ price: b.price, quantity: deficit });
      }
    }
    for (const a of desired.asks) {
      const existing = existingQtyByPrice.get(a.price) ?? 0n;
      const deficit = a.quantity - existing;
      if (deficit < 0n) {
        toPlace.push({ price: a.price, quantity: deficit });
      }
    }
    return toPlace;
  }

  /** Check whether any price level with an existing order has less quantity than desired. */
  private hasQuantityDeficit(desired: DesiredQuotes): boolean {
    const existingQtyByPrice = this.aggregateOwnQuantityByPrice();

    for (const b of desired.bids) {
      const existing = existingQtyByPrice.get(b.price);
      if (existing !== undefined && b.quantity - existing > 0n) return true;
    }
    for (const a of desired.asks) {
      const existing = existingQtyByPrice.get(a.price);
      if (existing !== undefined && a.quantity - existing < 0n) return true;
    }
    return false;
  }

  private aggregateOwnQuantityByPrice(): Map<bigint, bigint> {
    const qtyByPrice = new Map<bigint, bigint>();
    for (const order of this.book.ownOrders.values()) {
      const current = qtyByPrice.get(order.price) ?? 0n;
      qtyByPrice.set(order.price, current + order.quantity);
    }
    return qtyByPrice;
  }

  /** Compute gas cost in USD from a tx receipt. */
  private computeTxGasCost(receipt: { gasUsed: bigint; effectiveGasPrice: bigint }): bigint {
    if (this.gas.ethPriceUsd === 0n) return 0n;
    return (receipt.gasUsed * receipt.effectiveGasPrice * this.gas.ethPriceUsd) / 10n ** 18n;
  }
}
