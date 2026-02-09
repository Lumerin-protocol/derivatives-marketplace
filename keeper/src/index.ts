import { loadConfig } from "./config.ts";
import { createClients } from "./client.ts";
import { PositionTracker } from "./positionTracker.ts";
import { Liquidator } from "./liquidator.ts";
import { HealthCheck } from "./healthcheck.ts";
import pino from "pino";

async function main(): Promise<void> {
  const config = loadConfig();

  const logger = pino({ level: config.logLevel as pino.Level });

  logger.info(
    {
      perpsAddress: config.perpsAddress,
      pollIntervalMs: config.pollIntervalMs,
      resyncIntervalMs: config.resyncIntervalMs,
      dryRun: config.dryRun,
      healthPort: config.healthPort,
    },
    "Starting keeper",
  );

  const { publicClient, walletClient, account } = createClients(config);
  logger.info({ address: account.address }, "Wallet ready");

  // ── Components ──────────────────────────────────────────────────────────

  const tracker = new PositionTracker(publicClient, config, logger);
  const liquidator = new Liquidator(publicClient, walletClient, account, tracker, config, logger);
  const health = new HealthCheck(tracker, liquidator, config, logger);

  // ── Graceful shutdown ───────────────────────────────────────────────────

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down…");
    liquidator.stop();
    tracker.stop();
    health.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // ── Start ───────────────────────────────────────────────────────────────

  await tracker.start();
  await liquidator.start();
  health.start();

  logger.info("Keeper is running");
}

main();
