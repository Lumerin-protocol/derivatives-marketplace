import type { Log, PublicClient, WatchContractEventReturnType } from "viem";
import type { MakerConfig } from "./config.ts";
import type pino from "pino";
import { hashPowerPerpsDexAbi } from "./abi.ts";

export interface OwnOrder {
  orderId: `0x${string}`;
  price: bigint;
  quantity: bigint;
}

export class BookTracker {
  bestBid = 0n;
  bestAsk = 0n;
  midPrice = 0n;

  /** Map of orderId -> OwnOrder for the MM's resting orders. */
  readonly ownOrders = new Map<`0x${string}`, OwnOrder>();

  /** Depth per price level per side. bidDepth[price] = total quantity. */
  private readonly bidDepth = new Map<bigint, bigint>();
  private readonly askDepth = new Map<bigint, bigint>();

  private readonly publicClient: PublicClient;
  private readonly config: MakerConfig;
  private readonly logger: pino.Logger;
  private readonly mmAddress: `0x${string}`;

  private unwatch: WatchContractEventReturnType | null = null;
  private lastResyncAt = 0;

  constructor(
    publicClient: PublicClient,
    config: MakerConfig,
    mmAddress: `0x${string}`,
    logger: pino.Logger,
  ) {
    this.publicClient = publicClient;
    this.config = config;
    this.mmAddress = mmAddress;
    this.logger = logger.child({ component: "book" });
  }

  async start(): Promise<void> {
    await this.fullResync();
    this.watchEvents();
  }

  stop(): void {
    this.unwatch?.();
    this.unwatch = null;
  }

  /** Periodic resync if interval elapsed. Called each tick. */
  async refresh(): Promise<void> {
    if (Date.now() - this.lastResyncAt > this.config.resyncIntervalMs) {
      await this.fullResync();
    }
  }

  depthAtPrice(price: bigint, isBid: boolean): bigint {
    return (isBid ? this.bidDepth : this.askDepth).get(price) ?? 0n;
  }

  private async fullResync(): Promise<void> {
    this.bidDepth.clear();
    this.askDepth.clear();

    const [bidPrices, askPrices] = await this.publicClient.readContract({
      address: this.config.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      functionName: "getOrderBookPrices",
      args: [200n],
    });

    const depthCalls = [
      ...bidPrices.map((p) => ({
        address: this.config.perpsAddress,
        abi: hashPowerPerpsDexAbi,
        functionName: "getQuantityAtPrice" as const,
        args: [p, true] as const,
      })),
      ...askPrices.map((p) => ({
        address: this.config.perpsAddress,
        abi: hashPowerPerpsDexAbi,
        functionName: "getQuantityAtPrice" as const,
        args: [p, false] as const,
      })),
    ];

    if (depthCalls.length > 0) {
      const results = await this.publicClient.multicall({
        contracts: depthCalls,
        allowFailure: false,
      });

      for (let i = 0; i < bidPrices.length; i++) {
        const r = results[i];
        this.bidDepth.set(bidPrices[i], r);
      }
      for (let i = 0; i < askPrices.length; i++) {
        const r = results[bidPrices.length + i];
        this.askDepth.set(askPrices[i], r);
      }
    }

    this.bestBid = bidPrices.length > 0 ? bidPrices[0] : 0n;
    this.bestAsk = askPrices.length > 0 ? askPrices[0] : 0n;
    this.midPrice =
      this.bestBid > 0n && this.bestAsk > 0n ? (this.bestBid + this.bestAsk) / 2n : 0n;

    await this.resyncOwnOrders();
    this.lastResyncAt = Date.now();
    this.logger.info(
      {
        bestBid: this.bestBid.toString(),
        bestAsk: this.bestAsk.toString(),
        ownOrders: this.ownOrders.size,
      },
      "book resync",
    );
  }

  private async resyncOwnOrders(): Promise<void> {
    this.ownOrders.clear();

    const orderIds = await this.publicClient.readContract({
      address: this.config.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      functionName: "getUserOrders",
      args: [this.mmAddress],
    });

    if (orderIds.length === 0) return;

    const orderCalls = orderIds.map((id) => ({
      address: this.config.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      functionName: "getOrder" as const,
      args: [id] as const,
    }));

    const results = await this.publicClient.multicall({
      contracts: orderCalls,
      allowFailure: false,
    });

    for (let i = 0; i < orderIds.length; i++) {
      const order = results[i];
      const orderId = orderIds[i];
      this.ownOrders.set(orderId, {
        orderId: orderId,
        price: order.price,
        quantity: order.quantity,
      });
    }
  }

  private watchEvents(): void {
    this.unwatch = this.publicClient.watchContractEvent({
      address: this.config.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      onLogs: (logs) => {
        for (const log of logs) {
          this.handleEvent(log as any);
        }
      },
    });
  }

  private handleEvent(log: Log<bigint, number, false, undefined, false, typeof hashPowerPerpsDexAbi>) {
    switch (log.eventName) {
      case "OrderCreated": {
        const participant = log.args.participant;
        const orderId = log.args.orderId;
        const price = log.args.price;
        const quantity = log.args.quantity;
        if (!participant || !orderId || price === undefined || quantity === undefined) return;

        if (participant.toLowerCase() === this.mmAddress.toLowerCase()) {
          this.ownOrders.set(orderId, { orderId, price, quantity });
        }
        break;
      }
      case "OrderCancelled": {
        const orderId = log.args.orderId;
        if (orderId) this.ownOrders.delete(orderId);
        break;
      }
      case "OrderUpdated": {
        const orderId = log.args.orderId;
        const newQuantity = log.args.newQuantity;
        if (!orderId || newQuantity === undefined) return;

        const existing = this.ownOrders.get(orderId);
        if (existing) {
          if (newQuantity === 0n) {
            this.ownOrders.delete(orderId);
          } else {
            existing.quantity = newQuantity;
          }
        }
        break;
      }
      case "OrderMatched": {
        const makerOrderId = log.args.makerOrderId;
        if (makerOrderId) {
          this.logger.info({ makerOrderId }, "own order matched");
        }
        break;
      }
    }
  }
}
