import type { MakerConfig } from "./config.ts";
import type { InventoryManager } from "./inventoryManager.ts";
import type { GasTracker } from "./gasTracker.ts";
import type { OracleTracker } from "./oracleTracker.ts";
import type pino from "pino";
import { RollingBudget, bigAbs } from "./math.ts";
import type { ErrorInfo } from "./healthcheck.ts";
export type ThrottleReason = "gas_hourly" | "gas_daily" | "none";

export class RiskManager {
  halted = false;
  haltReason: ErrorInfo | null = null;
  throttled = false;
  throttleReason: ThrottleReason = "none";

  /** Track gas spending in rolling windows. */
  private readonly gasHourlyBudget: RollingBudget;
  private readonly gasDailyBudget: RollingBudget;

  /** Cumulative gas cost for PnL accounting. */
  cumulativeGasCostUsd = 0n;

  /** Snapshot of collateral at start of day (reset at midnight UTC or on startup). */
  private startOfDayBalance = 0n;
  private startOfDayTimestamp = 0;

  private readonly config: MakerConfig;
  private readonly inventory: InventoryManager;
  private readonly gas: GasTracker;
  private readonly oracle: OracleTracker;
  private readonly logger: pino.Logger;

  constructor(
    config: MakerConfig,
    inventory: InventoryManager,
    gas: GasTracker,
    oracle: OracleTracker,
    logger: pino.Logger,
  ) {
    this.config = config;
    this.inventory = inventory;
    this.gas = gas;
    this.oracle = oracle;
    this.logger = logger.child({ component: "risk" });
    this.gasHourlyBudget = new RollingBudget(60 * 60 * 1000);
    this.gasDailyBudget = new RollingBudget(24 * 60 * 60 * 1000);
  }

  /** Call once on startup to snapshot starting balance. */
  initialize(): void {
    this.startOfDayBalance = this.inventory.collateralBalance;
    this.startOfDayTimestamp = Date.now();
  }

  /** Record gas cost from a transaction. */
  recordGasCost(costUsd: bigint): void {
    this.gasHourlyBudget.add(costUsd);
    this.gasDailyBudget.add(costUsd);
    this.cumulativeGasCostUsd += costUsd;
  }

  /** Run all risk checks. Returns true if the bot should continue quoting. */
  check(): boolean {
    this.checkDayRollover();

    // Drawdown circuit breaker
    if (this.inventory.collateralBalance < this.config.minCollateralBalance) {
      this.halted = true;
      this.haltReason = {
        message: "collateral below minimum",
        balance: this.inventory.collateralBalance.toString(),
        min: this.config.minCollateralBalance.toString(),
      };
      this.logger.error(this.haltReason, "HALT: collateral below minimum");
      return false;
    }

    // Daily loss check (includes gas costs)
    const truePnl = this.truePnl();
    if (truePnl < 0n && bigAbs(truePnl) > this.config.maxDailyLossUsd) {
      this.halted = true;
      this.haltReason = {
        message: "daily loss limit breached",
        pnl: truePnl.toString(),
        max: this.config.maxDailyLossUsd.toString(),
      };
      this.logger.error(this.haltReason, "HALT: daily loss limit breached");
      return false;
    }

    this.halted = false;
    this.haltReason = null;

    // Gas budget throttling
    const hourlyGas = this.gasHourlyBudget.total();
    if (hourlyGas > this.config.maxGasBudgetPerHourUsd) {
      this.throttled = true;
      this.throttleReason = "gas_hourly";
      this.logger.warn(
        { hourlyGas: hourlyGas.toString(), max: this.config.maxGasBudgetPerHourUsd.toString() },
        "throttled: hourly gas budget exceeded",
      );
    } else {
      const dailyGas = this.gasDailyBudget.total();
      if (dailyGas > this.config.maxGasBudgetPerDayUsd) {
        this.throttled = true;
        this.throttleReason = "gas_daily";
        this.logger.warn({ dailyGas: dailyGas.toString() }, "throttled: daily gas budget exceeded");
      } else {
        this.throttled = false;
        this.throttleReason = "none";
      }
    }

    return true;
  }

  /**
   * Which sides should the MM quote?
   * Respects position limits: don't quote the side that would increase exposure beyond max.
   */
  allowedSides(): { quoteBid: boolean; quoteAsk: boolean } {
    const maxPos = this.config.maxPositionSize;
    const net = this.inventory.netQuantity;

    // If utilization is too high, stop quoting entirely
    if (this.inventory.utilizationPct > this.config.maxUtilizationPct) {
      // Only quote the side that reduces position
      if (net > 0n) return { quoteBid: false, quoteAsk: true };
      if (net < 0n) return { quoteBid: true, quoteAsk: false };
      return { quoteBid: false, quoteAsk: false };
    }

    return {
      quoteBid: net < maxPos,
      quoteAsk: net > -maxPos,
    };
  }

  /**
   * True PnL = (currentBalance - startBalance) - cumulativeGasCost
   * Negative = loss.
   */
  private truePnl(): bigint {
    const balanceDelta = this.inventory.collateralBalance - this.startOfDayBalance;
    return balanceDelta - this.cumulativeGasCostUsd;
  }

  /** Roll over start-of-day snapshot at midnight UTC. */
  private checkDayRollover(): void {
    const now = Date.now();
    const todayMidnight = new Date();
    todayMidnight.setUTCHours(0, 0, 0, 0);
    const midnightMs = todayMidnight.getTime();

    if (this.startOfDayTimestamp < midnightMs && now >= midnightMs) {
      this.startOfDayBalance = this.inventory.collateralBalance;
      this.startOfDayTimestamp = now;
      this.cumulativeGasCostUsd = 0n;
      this.logger.info("day rollover: PnL counters reset");
    }
  }
}
