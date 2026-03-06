import { createServer } from "node:http";
import type { Server } from "node:http";
import type { MakerConfig } from "./config.ts";
import type { OracleTracker } from "./oracleTracker.ts";
import type { InventoryManager } from "./inventoryManager.ts";
import type { BookTracker } from "./bookTracker.ts";
import type { GasTracker } from "./gasTracker.ts";
import type { RiskManager } from "./riskManager.ts";
import type pino from "pino";

export interface ExecutorStats {
  ordersPlaced: number;
  ordersCancelled: number;
  reconcileCount: number;
}

export interface ErrorInfo {
  message: string;
  [key: string]: unknown;
}

export class HealthCheck {
  private server: Server | null = null;
  private startedAt = Date.now();

  tickCount = 0;
  lastTickAt = 0;
  executorStats: ExecutorStats | null = null;
  walletAddress = "";
  status: "initializing" | "init-error" | "running" | "error" = "initializing";
  lastError: ErrorInfo | null = null;

  private readonly config: MakerConfig;
  private readonly oracle: OracleTracker;
  private readonly inventory: InventoryManager;
  private readonly book: BookTracker;
  private readonly gas: GasTracker;
  private readonly risk: RiskManager;
  private readonly logger: pino.Logger;

  constructor(
    config: MakerConfig,
    oracle: OracleTracker,
    inventory: InventoryManager,
    book: BookTracker,
    gas: GasTracker,
    risk: RiskManager,
    logger: pino.Logger,
  ) {
    this.config = config;
    this.oracle = oracle;
    this.inventory = inventory;
    this.book = book;
    this.gas = gas;
    this.risk = risk;
    this.logger = logger;
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.startedAt = Date.now();

      this.server = createServer((req, res) => {
        try {
          if (req.method === "GET" && req.url === "/health") {
            const body = JSON.stringify({
              status: this.status,
              walletAddress: this.walletAddress,
              lastError: this.lastError,
              uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
              config: {
                network: this.config.network,
                nodeEnv: this.config.nodeEnv,
                perpsAddress: this.config.perpsAddress,
                dryRun: this.config.dryRun,
                logLevel: this.config.logLevel,
                commitHash: this.config.commitHash,
                quoting: {
                  numLevelsPerSide: this.config.numLevelsPerSide,
                  baseQuantity: this.config.baseQuantity.toString(),
                  minSpreadBps: this.config.minSpreadBps,
                  volatilityMultiplier: this.config.volatilityMultiplier,
                  inventorySkewGamma: this.config.inventorySkewGamma,
                  maxSkewTicks: this.config.maxSkewTicks,
                },
                gas: {
                  ethPriceFeedAddress: this.config.ethPriceFeedAddress ?? null,
                  gasSpikeThresholdPct: this.config.gasSpikeThresholdPct,
                  gasCapMultiplier: this.config.gasCapMultiplier,
                  gasPenaltyBps: this.config.gasPenaltyBps,
                  maxGasBudgetPerHourUsd: this.config.maxGasBudgetPerHourUsd.toString(),
                  maxGasBudgetPerDayUsd: this.config.maxGasBudgetPerDayUsd.toString(),
                  urgentRequoteThresholdTicks: this.config.urgentRequoteThresholdTicks,
                },
                risk: {
                  maxPositionSize: this.config.maxPositionSize.toString(),
                  maxUtilizationPct: this.config.maxUtilizationPct,
                  minCollateralBalance: this.config.minCollateralBalance.toString(),
                  maxDailyLossUsd: this.config.maxDailyLossUsd.toString(),
                },
                timing: {
                  pollIntervalMs: this.config.pollIntervalMs,
                  requoteThresholdTicks: this.config.requoteThresholdTicks,
                  requoteCooldownMs: this.config.requoteCooldownMs,
                  resyncIntervalMs: this.config.resyncIntervalMs,
                },
              },
              market: {
                oraclePrice: this.oracle.currentPrice.toString(),
                volatility: this.oracle.volatility,
                bestBid: this.book.bestBid.toString(),
                bestAsk: this.book.bestAsk.toString(),
                ownOrders: this.book.ownOrders.size,
              },
              inventory: {
                netPosition: this.inventory.netQuantity.toString(),
                collateralBalance: this.inventory.collateralBalance.toString(),
                ethBalance: this.inventory.ethBalance.toString(),
                tokenBalance: this.inventory.tokenBalance.toString(),
                inventorySkew: this.inventory.inventorySkew,
                utilizationPct: this.inventory.utilizationPct,
              },
              gas: {
                gasGwei: (Number(this.gas.currentGasPrice) / 1e9).toFixed(2),
                gasSpiking: this.gas.isGasSpiking,
                gasSpikePct: this.gas.gasSpikePct.toFixed(0),
              },
              risk: {
                throttled: this.risk.throttled,
                throttleReason: this.risk.throttleReason,
                cumulativeGasCostUsd: this.risk.cumulativeGasCostUsd.toString(),
              },
              stats: {
                tickCount: this.tickCount,
                lastTickAt: this.lastTickAt,
                ordersPlaced: this.executorStats?.ordersPlaced ?? 0,
                ordersCancelled: this.executorStats?.ordersCancelled ?? 0,
                reconcileCount: this.executorStats?.reconcileCount ?? 0,
              },
            });

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(body);
          } else {
            res.writeHead(404);
            res.end();
          }
        } catch (err) {
          this.logger.error({ err }, "server error");
          res.writeHead(500);
          res.end();
        }
      });

      const logger = this.logger;

      this.server.listen(this.config.healthPort, () => {
        logger.info(
          { url: `http://localhost:${this.config.healthPort}/health` },
          "Health endpoint started",
        );
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((err) => {
        this.server = null;
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
