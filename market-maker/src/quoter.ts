import type { PublicClient } from "viem";
import type { MakerConfig } from "./config.ts";
import type { OracleTracker } from "./oracleTracker.ts";
import type { GasTracker } from "./gasTracker.ts";
import type { InventoryManager } from "./inventoryManager.ts";
import type { RiskManager } from "./riskManager.ts";
import type pino from "pino";
import { perpsSimpleAbi } from "./abi.ts";
import { roundDownToTick, roundUpToTick, BPS_SCALE, calculateNotional } from "./math.ts";

export interface QuoteLevel {
  price: bigint;
  quantity: bigint;
}

export interface DesiredQuotes {
  bids: QuoteLevel[];
  asks: QuoteLevel[];
}

export class Quoter {
  private tick = 0n;
  private readonly publicClient: PublicClient;
  private readonly config: MakerConfig;
  private readonly oracle: OracleTracker;
  private readonly gas: GasTracker;
  private readonly inventory: InventoryManager;
  private readonly risk: RiskManager;
  private readonly logger: pino.Logger;

  constructor(
    publicClient: PublicClient,
    config: MakerConfig,
    oracle: OracleTracker,
    gas: GasTracker,
    inventory: InventoryManager,
    risk: RiskManager,
    logger: pino.Logger,
  ) {
    this.publicClient = publicClient;
    this.config = config;
    this.oracle = oracle;
    this.gas = gas;
    this.inventory = inventory;
    this.risk = risk;
    this.logger = logger.child({ component: "quoter" });
  }

  async initialize(): Promise<void> {
    this.tick = await this.publicClient.readContract({
      address: this.config.perpsAddress,
      abi: perpsSimpleAbi,
      functionName: "minimumPriceIncrement",
    });
    this.logger.info({ tick: this.tick.toString() }, "quoter initialized");
  }

  getTick(): bigint {
    return this.tick;
  }

  computeQuotes(): DesiredQuotes {
    const oraclePrice = this.oracle.currentPrice;
    if (oraclePrice === 0n || this.tick === 0n) {
      return { bids: [], asks: [] };
    }

    const spreadBps = this.effectiveSpreadBps();
    const halfSpreadBps = BigInt(Math.round(spreadBps / 2));
    const skewBps = this.inventorySkewBps();

    const { quoteBid, quoteAsk } = this.risk.allowedSides();

    const bids: QuoteLevel[] = [];
    const asks: QuoteLevel[] = [];
    const n = this.config.numLevelsPerSide;

    for (let level = 0; level < n; level++) {
      const levelTicks = BigInt(level) * this.tick;
      const sizeMultiplier = BigInt(level + 1);
      const qty = this.config.baseQuantity * sizeMultiplier;

      if (quoteBid) {
        const bidRaw = (oraclePrice * (BPS_SCALE - halfSpreadBps - skewBps)) / BPS_SCALE - levelTicks;
        const bidPrice = roundDownToTick(bidRaw > 0n ? bidRaw : this.tick, this.tick);
        // Positive quantity = buy/long
        bids.push({ price: bidPrice, quantity: qty });
      }

      if (quoteAsk) {
        const askRaw = (oraclePrice * (BPS_SCALE + halfSpreadBps - skewBps)) / BPS_SCALE + levelTicks;
        const askPrice = roundUpToTick(askRaw, this.tick);
        // Negative quantity = sell/short
        asks.push({ price: askPrice, quantity: askPrice > 0n ? -qty : 0n });
      }
    }

    this.logger.debug(
      {
        spreadBps: spreadBps.toFixed(1),
        skewBps: Number(skewBps),
        bidLevels: bids.length,
        askLevels: asks.length,
        bidTop: bids[0]?.price.toString(),
        askTop: asks[0]?.price.toString(),
      },
      "quotes computed",
    );

    return { bids, asks };
  }

  /** Effective spread in basis points (floating point for precision). */
  private effectiveSpreadBps(): number {
    const cfg = this.config;

    const gasFloor = this.gasFloorBps();
    const base = Math.max(cfg.minSpreadBps, gasFloor);

    const volComponent = cfg.volatilityMultiplier * this.oracle.volatility * 10_000;

    const invComponent = Math.abs(this.inventory.inventorySkew) * cfg.minSpreadBps;

    const gasSpikeComponent =
      this.gas.gasSpikePct > 0
        ? cfg.gasPenaltyBps * (this.gas.gasSpikePct / 100)
        : 0;

    return base + volComponent + invComponent + gasSpikeComponent;
  }

  /**
   * Gas floor: minimum spread in bps to break even on gas costs.
   * gasFloorBps = roundTripCostUsd / expectedNotionalPerFill * 10000
   */
  private gasFloorBps(): number {
    const rtCost = this.gas.roundTripCostUsd;
    if (rtCost === 0n) return 0;

    const expectedNotional = calculateNotional(
      this.oracle.currentPrice,
      this.config.baseQuantity,
    );
    if (expectedNotional === 0n) return 0;

    return Number(rtCost * 10_000n / expectedNotional);
  }

  /**
   * Inventory skew in BPS applied to both bid and ask (shifts quotes).
   * Positive skew = long inventory → shift quotes down (less aggressive buys, more aggressive sells).
   */
  private inventorySkewBps(): bigint {
    const skewTicks = Math.round(
      this.config.inventorySkewGamma *
        this.inventory.inventorySkew *
        this.config.maxSkewTicks,
    );
    // Convert skew ticks to a BPS-like offset on the oracle price
    if (this.oracle.currentPrice === 0n) return 0n;
    const offsetValue = BigInt(skewTicks) * this.tick;
    return (offsetValue * BPS_SCALE) / this.oracle.currentPrice;
  }
}
