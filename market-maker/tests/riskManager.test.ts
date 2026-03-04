import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { RiskManager } from "../src/riskManager.ts";
import type { MakerConfig } from "../src/config.ts";
import type { InventoryManager } from "../src/inventoryManager.ts";
import type { GasTracker } from "../src/gasTracker.ts";
import type { OracleTracker } from "../src/oracleTracker.ts";

function makeConfig(overrides: Partial<MakerConfig> = {}): MakerConfig {
  return {
    network: "hardhat",
    ethNodeAddress: "http://localhost:8545",
    perpsAddress: "0x0000000000000000000000000000000000000001",
    makerPrivateKey: "0x0000000000000000000000000000000000000000000000000000000000000001",
    numLevelsPerSide: 5,
    baseQuantity: 1_000_000n,
    minSpreadBps: 10,
    volatilityMultiplier: 2.0,
    inventorySkewGamma: 0.5,
    maxSkewTicks: 20,
    ethPriceFeedAddress: undefined,
    gasSpikeThresholdPct: 200,
    gasCapMultiplier: 2.0,
    gasPenaltyBps: 5,
    maxGasBudgetPerHourUsd: 50_000_000n,
    maxGasBudgetPerDayUsd: 500_000_000n,
    urgentRequoteThresholdTicks: 10,
    maxPositionSize: 100_000_000n,
    maxUtilizationPct: 80,
    minCollateralBalance: 100_000_000n,
    maxDailyLossUsd: 500_000_000n,
    pollIntervalMs: 3000,
    requoteThresholdTicks: 2,
    requoteCooldownMs: 1000,
    resyncIntervalMs: 60000,
    dryRun: false,
    healthPort: 3001,
    logLevel: "silent",
    ...overrides,
  } as MakerConfig;
}

function makeInventory(overrides: Partial<InventoryManager> = {}): InventoryManager {
  return {
    netQuantity: 0n,
    collateralBalance: 1_000_000_000n,
    requiredMargin: 100_000_000n,
    inventorySkew: 0,
    availableMargin: 900_000_000n,
    utilizationPct: 10,
    ...overrides,
  } as InventoryManager;
}

function makeGas(): GasTracker {
  return {} as GasTracker;
}

function makeOracle(): OracleTracker {
  return { currentPrice: 100_000_000n } as OracleTracker;
}

function makeLogger(): never {
  return { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) } as never;
}

describe("RiskManager", () => {
  it("allows quoting when healthy", () => {
    const risk = new RiskManager(makeConfig(), makeInventory(), makeGas(), makeOracle(), makeLogger());
    risk.initialize();
    const ok = risk.check();
    assert.ok(ok);
    assert.equal(risk.halted, false);
  });

  it("halts on drawdown (collateral below min)", () => {
    const inv = makeInventory({ collateralBalance: 50_000_000n });
    const risk = new RiskManager(
      makeConfig({ minCollateralBalance: 100_000_000n }),
      inv, makeGas(), makeOracle(), makeLogger(),
    );
    risk.initialize();
    const ok = risk.check();
    assert.equal(ok, false);
    assert.equal(risk.halted, true);
    assert.equal(risk.haltReason?.message, "collateral below minimum");
  });

  it("halts on daily loss exceeding limit", () => {
    // Start with 1000 USDC, then "lose" by having balance drop to 400
    const inv = makeInventory({ collateralBalance: 400_000_000n });
    const config = makeConfig({ maxDailyLossUsd: 500_000_000n, minCollateralBalance: 0n });
    const risk = new RiskManager(config, inv, makeGas(), makeOracle(), makeLogger());

    // Manually set start-of-day balance high to simulate loss
    risk.initialize();
    // Hack: access private field via any for testing
    (risk as Record<string, unknown>).startOfDayBalance = 1_000_000_000n;

    const ok = risk.check();
    assert.equal(ok, false);
    assert.equal(risk.haltReason?.message, "daily loss limit breached");
  });

  it("records gas costs in budget", () => {
    const risk = new RiskManager(makeConfig(), makeInventory(), makeGas(), makeOracle(), makeLogger());
    risk.initialize();

    risk.recordGasCost(10_000_000n);
    risk.recordGasCost(20_000_000n);
    assert.equal(risk.cumulativeGasCostUsd, 30_000_000n);
  });

  it("allows both sides when position is neutral", () => {
    const inv = makeInventory({ netQuantity: 0n });
    const risk = new RiskManager(makeConfig(), inv, makeGas(), makeOracle(), makeLogger());
    const sides = risk.allowedSides();
    assert.equal(sides.quoteBid, true);
    assert.equal(sides.quoteAsk, true);
  });

  it("blocks bid side when at max long", () => {
    const inv = makeInventory({ netQuantity: 100_000_000n, utilizationPct: 90 });
    const config = makeConfig({ maxPositionSize: 100_000_000n, maxUtilizationPct: 80 });
    const risk = new RiskManager(config, inv, makeGas(), makeOracle(), makeLogger());
    const sides = risk.allowedSides();
    assert.equal(sides.quoteBid, false);
    assert.equal(sides.quoteAsk, true);
  });

  it("blocks ask side when at max short", () => {
    const inv = makeInventory({ netQuantity: -100_000_000n, utilizationPct: 90 });
    const config = makeConfig({ maxPositionSize: 100_000_000n, maxUtilizationPct: 80 });
    const risk = new RiskManager(config, inv, makeGas(), makeOracle(), makeLogger());
    const sides = risk.allowedSides();
    assert.equal(sides.quoteBid, true);
    assert.equal(sides.quoteAsk, false);
  });

  it("throttles when hourly gas budget exceeded", () => {
    const config = makeConfig({ maxGasBudgetPerHourUsd: 10_000_000n });
    const risk = new RiskManager(config, makeInventory(), makeGas(), makeOracle(), makeLogger());
    risk.initialize();

    risk.recordGasCost(15_000_000n);
    risk.check();

    assert.equal(risk.throttled, true);
    assert.equal(risk.throttleReason, "gas_hourly");
  });

  it("throttles when daily gas budget exceeded but hourly is fine", () => {
    const config = makeConfig({
      maxGasBudgetPerHourUsd: 1_000_000_000n,
      maxGasBudgetPerDayUsd: 10_000_000n,
    });
    const risk = new RiskManager(config, makeInventory(), makeGas(), makeOracle(), makeLogger());
    risk.initialize();

    risk.recordGasCost(15_000_000n);
    risk.check();

    assert.equal(risk.throttled, true);
    assert.equal(risk.throttleReason, "gas_daily");
  });

  it("blocks both sides when utilization is high and position is zero", () => {
    const inv = makeInventory({ netQuantity: 0n, utilizationPct: 90 });
    const config = makeConfig({ maxUtilizationPct: 80 });
    const risk = new RiskManager(config, inv, makeGas(), makeOracle(), makeLogger());
    const sides = risk.allowedSides();
    assert.equal(sides.quoteBid, false);
    assert.equal(sides.quoteAsk, false);
  });

  it("resets PnL counters on day rollover", () => {
    const inv = makeInventory({ collateralBalance: 1_000_000_000n });
    const config = makeConfig({ minCollateralBalance: 0n, maxDailyLossUsd: 1_000_000_000n });
    const risk = new RiskManager(config, inv, makeGas(), makeOracle(), makeLogger());
    risk.initialize();

    risk.recordGasCost(50_000_000n);
    assert.equal(risk.cumulativeGasCostUsd, 50_000_000n);

    // Simulate day rollover by setting startOfDayTimestamp to yesterday
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    yesterday.setUTCHours(12, 0, 0, 0);
    (risk as Record<string, unknown>).startOfDayTimestamp = yesterday.getTime();

    risk.check();

    assert.equal(risk.cumulativeGasCostUsd, 0n);
  });

  it("includes gas costs in daily loss calculation", () => {
    const inv = makeInventory({ collateralBalance: 900_000_000n });
    const config = makeConfig({
      maxDailyLossUsd: 200_000_000n,
      minCollateralBalance: 0n,
    });
    const risk = new RiskManager(config, inv, makeGas(), makeOracle(), makeLogger());
    risk.initialize();
    // startOfDayBalance = 900_000_000

    // Balance unchanged but gas costs push total loss over limit
    // truePnl = (900M - 900M) - 250M = -250M, which exceeds 200M limit
    risk.recordGasCost(250_000_000n);
    const ok = risk.check();

    assert.equal(ok, false);
    assert.equal(risk.haltReason?.message, "daily loss limit breached");
  });
});
