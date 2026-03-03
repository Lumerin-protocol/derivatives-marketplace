import type { PublicClient, WalletClient, Account, Chain } from "viem";
import type { MakerConfig } from "./config.ts";
import type { Quoter, DesiredQuotes, QuoteLevel } from "./quoter.ts";
import type { BookTracker, OwnOrder } from "./bookTracker.ts";
import type { GasTracker } from "./gasTracker.ts";
import type { RiskManager } from "./riskManager.ts";
import type { OracleTracker } from "./oracleTracker.ts";
import type pino from "pino";
import { perpsSimpleAbi } from "./abi.ts";
import { bigAbs } from "./math.ts";

export class OrderExecutor {
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

    // Cancel all existing orders, then place new ones.
    // Selective requoting: only cancel orders that differ from desired.
    const ordersToCancel = this.findStaleOrders(desired);
    const ordersToPlace = this.findNewOrders(desired);

    if (ordersToCancel.length === 0 && ordersToPlace.length === 0) {
      this.logger.debug("no order changes needed");
      return;
    }

    const maxFeePerGas = this.gas.cappedGasPrice();

    // Cancel stale orders
    for (const order of ordersToCancel) {
      await this.cancelOrder(order.orderId, maxFeePerGas);
    }

    // Place new orders (quantity is already signed)
    for (const level of ordersToPlace) {
      await this.placeOrder(level.price, level.quantity, maxFeePerGas);
    }

    this.lastRequoteAt = Date.now();
    this.lastQuoteMidPrice = this.oracle.currentPrice;
  }

  /** Cancel all MM orders (used by circuit breaker). */
  async cancelAll(): Promise<void> {
    const orders = [...this.book.ownOrders.values()];
    if (orders.length === 0) return;

    this.logger.warn({ count: orders.length }, "cancelling all orders");
    const maxFeePerGas = this.gas.cappedGasPrice();

    for (const order of orders) {
      await this.cancelOrder(order.orderId, maxFeePerGas);
    }
  }

  private shouldRequote(desired: DesiredQuotes): boolean {
    // Cooldown check
    if (Date.now() - this.lastRequoteAt < this.effectiveCooldownMs()) {
      return false;
    }

    // If no orders exist and we have desired quotes, requote
    if (this.book.ownOrders.size === 0 && (desired.bids.length > 0 || desired.asks.length > 0)) {
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
   * Find desired levels that don't have a matching existing order (should be placed).
   * Quantities are already signed: positive = buy, negative = sell.
   */
  private findNewOrders(desired: DesiredQuotes): QuoteLevel[] {
    const existingPrices = new Set<bigint>();
    for (const order of this.book.ownOrders.values()) {
      existingPrices.add(order.price);
    }

    const toPlace: QuoteLevel[] = [];
    for (const b of desired.bids) {
      if (!existingPrices.has(b.price)) {
        toPlace.push(b);
      }
    }
    for (const a of desired.asks) {
      if (!existingPrices.has(a.price)) {
        toPlace.push(a);
      }
    }
    return toPlace;
  }

  private async cancelOrder(orderId: `0x${string}`, maxFeePerGas: bigint): Promise<void> {
    if (this.config.dryRun) {
      this.logger.info({ orderId }, "DRY RUN: would cancel order");
      return;
    }

    try {
      const hash = await this.walletClient.writeContract({
        address: this.config.perpsAddress,
        abi: perpsSimpleAbi,
        functionName: "cancelOrder",
        args: [orderId],
        account: this.account,
        chain: this.chain,
        maxFeePerGas,
      });

      const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
      const gasCost = this.computeTxGasCost(receipt);
      this.risk.recordGasCost(gasCost);

      this.logger.info({ orderId, gas: receipt.gasUsed.toString() }, "order cancelled");
    } catch (err) {
      this.logger.error({ orderId, err }, "cancel failed");
    }
  }

  private async placeOrder(
    price: bigint,
    quantity: bigint,
    maxFeePerGas: bigint,
  ): Promise<void> {
    const signedQty = quantity;

    if (this.config.dryRun) {
      this.logger.info(
        { price: price.toString(), qty: signedQty.toString() },
        "DRY RUN: would place order",
      );
      return;
    }

    try {
      const hash = await this.walletClient.writeContract({
        address: this.config.perpsAddress,
        abi: perpsSimpleAbi,
        functionName: "createOrder",
        args: [price, signedQty],
        account: this.account,
        chain: this.chain,
        maxFeePerGas,
      });

      const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
      const gasCost = this.computeTxGasCost(receipt);
      this.risk.recordGasCost(gasCost);

      this.logger.info(
        { price: price.toString(), qty: signedQty.toString(), gas: receipt.gasUsed.toString() },
        "order placed",
      );
    } catch (err) {
      this.logger.error({ price: price.toString(), qty: signedQty.toString(), err }, "place failed");
    }
  }

  /** Compute gas cost in USD from a tx receipt. */
  private computeTxGasCost(receipt: { gasUsed: bigint; effectiveGasPrice: bigint }): bigint {
    if (this.gas.ethPriceUsd === 0n) return 0n;
    return (receipt.gasUsed * receipt.effectiveGasPrice * this.gas.ethPriceUsd) / 10n ** 18n;
  }
}
