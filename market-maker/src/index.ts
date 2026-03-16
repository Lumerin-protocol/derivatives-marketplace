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
import type { ErrorInfo } from "./healthcheck.ts";
import { serializeError } from "./errSerializer.ts";
import { topUpCollateral } from "./collateral.ts";

function toErrorInfo(err: unknown): ErrorInfo {
  if (!(err instanceof Error)) {
    return { message: String(err) };
  }
  return serializeError(err) as unknown as ErrorInfo;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({
    level: config.logLevel,
    serializers: { err: serializeError },
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

  const BASE_ERROR_DELAY_MS = 5 * 1000;
  const MAX_ERROR_DELAY_MS = 3 * 60 * 1000;

  risk.initialize();
  health.executorStats = executor.stats;
  health.walletAddress = mmAddress;

  health.onStop = async () => {
    logger.info("stop requested via API, cancelling orders");
    await executor.cancelAll();
    book.stop();
  };

  health.onStart = async () => {
    logger.info("start requested via API, re-initializing");
    await book.start();
    await oracle.update();
    await gas.update();
    await inventory.update();
  };

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
      health.status = "init-error";
      health.lastError = toErrorInfo(err);
      const delay = Math.min(BASE_ERROR_DELAY_MS * 2 ** (attempt - 1), MAX_ERROR_DELAY_MS);
      logger.warn({ err, attempt, retryInMs: delay }, "initialization failed, retrying");
      await sleep(delay);
    }
  }

  logger.info("initialization complete, entering main loop");

  // Graceful shutdown
  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down…");

    try {
      await executor.cancelAll();
    } catch (err) {
      logger.error({ err }, "failed to cancel orders during shutdown");
    }

    book.stop();
    await health.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // Main loop
  logger.info("market maker is running");

  let consecutiveErrors = 0;

  while (!shuttingDown) {
    if (health.paused) {
      await sleep(config.pollIntervalMs);
      continue;
    }

    try {
      await oracle.update();
      await gas.update();
      await book.refresh();
      await inventory.update();

      if (inventory.tokenBalance > 0n && config.nodeEnv === "production") {
        try {
          await topUpCollateral({
            publicClient,
            walletClient,
            account,
            chain,
            perpsAddress: config.perpsAddress,
            inventory,
            logger,
          });
        } catch (err) {
          health.status = "error";
          health.lastError = toErrorInfo(err);
          logger.error({ err }, "failed to top up collateral");
        }
      }

      const spreadString =
        book.bestBid > 0n && book.bestAsk > 0n
          ? `${(((book.bestAsk - book.bestBid) * 10000n) / oracle.currentPrice).toString()}bps`
          : "-";

      logger.info(
        {
          oracle: oracle.currentPrice.toString(),
          bid: book.bestBid.toString(),
          ask: book.bestAsk.toString(),
          spread: spreadString,
          pos: inventory.netQuantity.toString(),
          collateralBalance: inventory.collateralBalance.toString(),
          ethBalance: inventory.ethBalance.toString(),
          tokenBalance: inventory.tokenBalance.toString(),
          orders: book.ownOrders.size,
          skew: inventory.inventorySkew.toFixed(3),
        },
        "tick",
      );

      const ok = risk.check();
      if (!ok) {
        health.status = "error";
        health.lastError = risk.haltReason;
        consecutiveErrors++;
        try {
          await executor.cancelAll();
        } catch (err) {
          health.lastError = toErrorInfo(err);
          logger.error({ err }, "failed to cancel orders after risk halt");
        }
      } else {
        const desired = quoter.computeQuotes();
        await executor.reconcile(desired);

        health.status = "running";
        health.lastError = null;
        consecutiveErrors = 0;
      }
    } catch (err) {
      consecutiveErrors++;
      health.status = "error";
      health.lastError = toErrorInfo(err);
      logger.error({ err }, "tick error");
    }

    health.tickCount++;
    health.lastTickAt = Date.now();

    const delay =
      consecutiveErrors > 0
        ? Math.min(BASE_ERROR_DELAY_MS * 2 ** consecutiveErrors, MAX_ERROR_DELAY_MS)
        : config.pollIntervalMs;
    await sleep(delay);
  }
}

main();
