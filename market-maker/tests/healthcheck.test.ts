import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { HealthCheck } from "../src/healthcheck.ts";
import type { MakerConfig } from "../src/config.ts";
import type { OracleTracker } from "../src/oracleTracker.ts";
import type { InventoryManager } from "../src/inventoryManager.ts";
import type { BookTracker } from "../src/bookTracker.ts";
import type { GasTracker } from "../src/gasTracker.ts";
import type { RiskManager } from "../src/riskManager.ts";

const noop = () => {};
function makeLogger(): never {
  return { info: noop, warn: noop, error: noop, child: () => makeLogger() } as never;
}

let nextPort = 19000;

function makeDeps() {
  const port = nextPort++;
  const config = { healthPort: port, dryRun: false } as MakerConfig;
  const oracle = { currentPrice: 100_000_000n, volatility: 0.005 } as OracleTracker;
  const inventory = {
    netQuantity: 5_000_000n,
    collateralBalance: 500_000_000n,
    inventorySkew: 0.05,
    utilizationPct: 15,
  } as InventoryManager;
  const book = {
    ownOrders: new Map(),
    bestBid: 99_000_000n,
    bestAsk: 101_000_000n,
  } as unknown as BookTracker;
  const gas = {
    currentGasPrice: 1_000_000_000n,
    isGasSpiking: false,
    gasSpikePct: 10,
  } as GasTracker;
  const risk = {
    halted: false,
    haltReason: "none",
    throttled: false,
    throttleReason: "none",
    cumulativeGasCostUsd: 50_000n,
  } as unknown as RiskManager;

  return { config, oracle, inventory, book, gas, risk, port };
}

describe("HealthCheck", () => {
  let health: HealthCheck | null = null;

  afterEach(async () => {
    await health?.stop();
    health = null;
  });

  it("starts and responds to /health with JSON", async () => {
    const { config, oracle, inventory, book, gas, risk, port } = makeDeps();
    health = new HealthCheck(config, oracle, inventory, book, gas, risk, makeLogger());
    health.status = "running";
    await health.start();

    const res = await fetch(`http://localhost:${port}/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json");

    const body = await res.json();
    assert.equal(body.status, "running");
    assert.equal(body.oraclePrice, "100000000");
    assert.equal(body.netPosition, "5000000");
    assert.equal(body.collateral, "500000000");
    assert.equal(body.inventorySkew, 0.05);
    assert.equal(body.utilizationPct, 15);
    assert.equal(body.bestBid, "99000000");
    assert.equal(body.bestAsk, "101000000");
    assert.equal(body.gasSpiking, false);
    assert.equal(body.dryRun, false);
    assert.ok(typeof body.uptimeSeconds === "number");
    assert.equal(body.haltReason, "none");
    assert.equal(body.throttled, false);
  });

  it("reports initializing status before init completes", async () => {
    const { config, oracle, inventory, book, gas, risk, port } = makeDeps();
    health = new HealthCheck(config, oracle, inventory, book, gas, risk, makeLogger());
    await health.start();

    const res = await fetch(`http://localhost:${port}/health`);
    const body = await res.json();
    assert.equal(body.status, "initializing");
    assert.equal(body.lastError, null);
  });

  it("reports init-error status with lastError on init failure", async () => {
    const { config, oracle, inventory, book, gas, risk, port } = makeDeps();
    health = new HealthCheck(config, oracle, inventory, book, gas, risk, makeLogger());
    health.status = "init-error";
    health.lastError = "insufficient funds for gas";
    await health.start();

    const res = await fetch(`http://localhost:${port}/health`);
    const body = await res.json();
    assert.equal(body.status, "init-error");
    assert.equal(body.lastError, "insufficient funds for gas");
  });

  it("reports error status when tick fails", async () => {
    const { config, oracle, inventory, book, gas, risk, port } = makeDeps();
    health = new HealthCheck(config, oracle, inventory, book, gas, risk, makeLogger());
    health.status = "error";
    health.lastError = "execution reverted";
    await health.start();

    const res = await fetch(`http://localhost:${port}/health`);
    const body = await res.json();
    assert.equal(body.status, "error");
    assert.equal(body.lastError, "execution reverted");
  });

  it("reports halted status when risk is halted", async () => {
    const deps = makeDeps();
    (deps.risk as Record<string, unknown>).halted = true;
    (deps.risk as Record<string, unknown>).haltReason = "drawdown";
    health = new HealthCheck(deps.config, deps.oracle, deps.inventory, deps.book, deps.gas, deps.risk, makeLogger());
    health.status = "halted";
    await health.start();

    const res = await fetch(`http://localhost:${deps.port}/health`);
    const body = await res.json();
    assert.equal(body.status, "halted");
    assert.equal(body.haltReason, "drawdown");
  });

  it("returns 404 for non-health paths", async () => {
    const { config, oracle, inventory, book, gas, risk, port } = makeDeps();
    health = new HealthCheck(config, oracle, inventory, book, gas, risk, makeLogger());
    await health.start();

    const res = await fetch(`http://localhost:${port}/other`);
    assert.equal(res.status, 404);
  });

  it("returns 404 for POST to /health", async () => {
    const { config, oracle, inventory, book, gas, risk, port } = makeDeps();
    health = new HealthCheck(config, oracle, inventory, book, gas, risk, makeLogger());
    await health.start();

    const res = await fetch(`http://localhost:${port}/health`, { method: "POST" });
    assert.equal(res.status, 404);
  });

  it("stop is idempotent", async () => {
    const { config, oracle, inventory, book, gas, risk } = makeDeps();
    health = new HealthCheck(config, oracle, inventory, book, gas, risk, makeLogger());
    await health.start();
    await health.stop();
    await health.stop();
    health = null;
  });

  it("stop without start does not throw", async () => {
    const { config, oracle, inventory, book, gas, risk } = makeDeps();
    health = new HealthCheck(config, oracle, inventory, book, gas, risk, makeLogger());
    await health.stop();
    health = null;
  });
});
