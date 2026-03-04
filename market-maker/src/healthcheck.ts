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

export class HealthCheck {
  private server: Server | null = null;
  private startedAt = Date.now();

  tickCount = 0;
  lastTickAt = 0;
  executorStats: ExecutorStats | null = null;
  walletAddress = "";
  status: "initializing" | "init-error" | "running" | "error" | "halted" = "initializing";
  lastError: string | null = null;

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
        if (req.method === "GET" && req.url === "/health") {
          const body = JSON.stringify({
            status: this.status === "running" && this.risk.halted ? "halted" : this.status,
            walletAddress: this.walletAddress,
            lastError: this.lastError,
            haltReason: this.risk.haltReason,
            throttled: this.risk.throttled,
            throttleReason: this.risk.throttleReason,
            oraclePrice: this.oracle.currentPrice.toString(),
            volatility: this.oracle.volatility,
            netPosition: this.inventory.netQuantity.toString(),
            collateral: this.inventory.collateralBalance.toString(),
            inventorySkew: this.inventory.inventorySkew,
            utilizationPct: this.inventory.utilizationPct,
            ownOrders: this.book.ownOrders.size,
            bestBid: this.book.bestBid.toString(),
            bestAsk: this.book.bestAsk.toString(),
            gasGwei: (Number(this.gas.currentGasPrice) / 1e9).toFixed(2),
            gasSpiking: this.gas.isGasSpiking,
            gasSpikePct: this.gas.gasSpikePct.toFixed(0),
            cumulativeGasCostUsd: this.risk.cumulativeGasCostUsd.toString(),
            tickCount: this.tickCount,
            lastTickAt: this.lastTickAt,
            ordersPlaced: this.executorStats?.ordersPlaced ?? 0,
            ordersCancelled: this.executorStats?.ordersCancelled ?? 0,
            reconcileCount: this.executorStats?.reconcileCount ?? 0,
            uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
            dryRun: this.config.dryRun,
          });

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(body);
        } else {
          res.writeHead(404);
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
