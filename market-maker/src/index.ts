import pino from "pino";
import { loadConfig } from "./config.ts";
import { createClients } from "./client.ts";
import { OracleTracker } from "./oracleTracker.ts";
import { GasTracker } from "./gasTracker.ts";
import { BookTracker } from "./bookTracker.ts";
import { InventoryManager } from "./inventoryManager.ts";
import { Quoter } from "./quoter.ts";
import { OrderExecutor } from "./orderExecutor.ts";
import { RiskManager } from "./riskManager.ts";
import { HealthCheck } from "./healthcheck.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.logLevel });

  logger.info(
    {
      perpsAddress: config.perpsAddress,
      pollIntervalMs: config.pollIntervalMs,
      numLevelsPerSide: config.numLevelsPerSide,
      minSpreadBps: config.minSpreadBps,
      maxPositionSize: config.maxPositionSize.toString(),
      dryRun: config.dryRun,
    },
    "starting market maker",
  );

  const { publicClient, walletClient, account, chain } = createClients(config);
  const mmAddress = account.address;
  logger.info({ address: mmAddress }, "wallet ready");

  const oracle = new OracleTracker(publicClient, config, logger);
  const gas = new GasTracker(publicClient, config, logger);
  const book = new BookTracker(publicClient, config, mmAddress, logger);
  const inventory = new InventoryManager(publicClient, config, mmAddress, logger);
  const risk = new RiskManager(config, inventory, gas, oracle, logger);
  const quoter = new Quoter(publicClient, config, oracle, gas, inventory, risk, logger);
  const executor = new OrderExecutor(
    publicClient, walletClient, account, chain, config,
    quoter, book, gas, risk, oracle, logger,
  );
  const health = new HealthCheck(config, oracle, inventory, book, gas, risk, logger);

  // Initialization
  await quoter.initialize();
  await gas.calibrate(mmAddress);
  await book.start();
  await oracle.update();
  await gas.update();
  await inventory.update();
  risk.initialize();
  await health.start();

  logger.info("initialization complete, entering main loop");

  // Graceful shutdown
  let shuttingDown = false;
  let loopTimer: ReturnType<typeof setTimeout> | null = null;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down…");

    if (loopTimer) clearTimeout(loopTimer);

    try {
      await executor.cancelAll();
    } catch (err) {
      logger.error({ err }, "failed to cancel orders during shutdown");
    }

    book.stop();
    health.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // Main loop
  const tick = async () => {
    if (shuttingDown) return;

    try {
      await oracle.update();
      await gas.update();
      await book.refresh();
      await inventory.update();

      const ok = risk.check();
      if (!ok) {
        await executor.cancelAll();
        return;
      }

      const desired = quoter.computeQuotes();
      await executor.reconcile(desired);
    } catch (err) {
      logger.error({ err }, "tick error");
    }

    if (!shuttingDown) {
      loopTimer = setTimeout(() => void tick(), config.pollIntervalMs);
    }
  };

  await tick();

  logger.info("market maker is running");
}

main();
