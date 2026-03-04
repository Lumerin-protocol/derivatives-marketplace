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
import { trimmedErrSerializer } from "./errSerializer.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({
    level: config.logLevel,
    serializers: { err: trimmedErrSerializer },
  });

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
    publicClient,
    walletClient,
    account,
    chain,
    config,
    quoter,
    book,
    gas,
    risk,
    oracle,
    logger,
  );
  const health = new HealthCheck(config, oracle, inventory, book, gas, risk, logger);

  // Initialization — retry on transient blockchain errors (low ETH, low collateral, RPC hiccups)
  const INIT_BASE_DELAY_MS = 10_000;
  const INIT_MAX_DELAY_MS = 120_000;

  risk.initialize();
  health.executorStats = executor.stats;
  health.walletAddress = mmAddress;
  await health.start();

  for (let attempt = 1; ; attempt++) {
    try {
      await quoter.initialize();
      await gas.calibrate(mmAddress);
      await book.start();
      await oracle.update();
      await gas.update();
      await inventory.update();
      health.status = "running";
      health.lastError = null;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      health.status = "init-error";
      health.lastError = msg;
      const delay = Math.min(INIT_BASE_DELAY_MS * 2 ** (attempt - 1), INIT_MAX_DELAY_MS);
      logger.warn({ err, attempt, retryInMs: delay }, "initialization failed, retrying");
      await new Promise((r) => setTimeout(r, delay));
    }
  }

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

      health.status = "running";
      health.lastError = null;

      logger.info(
        {
          oracle: oracle.currentPrice.toString(),
          bid: book.bestBid.toString(),
          ask: book.bestAsk.toString(),
          spread:
            book.bestBid > 0n && book.bestAsk > 0n
              ? `${(((book.bestAsk - book.bestBid) * 10000n) / oracle.currentPrice).toString()}bps`
              : "-",
          pos: inventory.netQuantity.toString(),
          orders: book.ownOrders.size,
          skew: inventory.inventorySkew.toFixed(3),
        },
        "tick",
      );
    } catch (err) {
      health.status = "error";
      health.lastError = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "tick error");
    }

    health.tickCount++;
    health.lastTickAt = Date.now();

    if (!shuttingDown) {
      loopTimer = setTimeout(() => void tick(), config.pollIntervalMs);
    }
  };

  await tick();

  logger.info("market maker is running");
}

main();
