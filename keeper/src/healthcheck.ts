import { createServer } from "node:http";
import type { Server } from "node:http";
import type { Config } from "./config.ts";
import type { PositionTracker } from "./positionTracker.ts";
import type { Liquidator } from "./liquidator.ts";
import type pino from "pino";

export class HealthCheck {
  private server: Server | null = null;
  private startedAt = Date.now();
  private readonly tracker: PositionTracker;
  private readonly liquidator: Liquidator;
  private readonly config: Config;
  private readonly logger: pino.Logger;

  constructor(
    tracker: PositionTracker,
    liquidator: Liquidator,
    config: Config,
    logger: pino.Logger,
  ) {
    this.tracker = tracker;
    this.liquidator = liquidator;
    this.config = config;
    this.logger = logger;
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.startedAt = Date.now();

      this.server = createServer((req, res) => {
        if (req.method === "GET" && req.url === "/health") {
          const { lastPrice, lastCheckAt, liquidationsExecuted } = this.liquidator.stats;
          const body = JSON.stringify({
            status: "running",
            trackedPositions: this.tracker.getUsers().size,
            lastPriceCheckAt: lastCheckAt?.toISOString() ?? null,
            lastPrice: lastPrice.toString(),
            liquidationsExecuted,
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

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}
