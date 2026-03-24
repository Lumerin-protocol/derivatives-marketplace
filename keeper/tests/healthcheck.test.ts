import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { getContract, parseUnits } from "viem";
import pino from "pino";

import { HealthCheck } from "../src/healthcheck.ts";
import { PositionTracker } from "../src/positionTracker.ts";
import { Liquidator } from "../src/liquidator.ts";
import { hashPowerPerpsDexAbi } from "../src/abi.ts";
import {
  startHardhatNode,
  createKeeperConfig,
  waitFor,
  sleep,
  type HardhatNode,
  loadFixture,
} from "./helpers.ts";
import {
  deployWithCollateralFixture,
  deployWithLiquidatablePositionFixture,
} from "../../contracts/fixtures/viem.ts";

const silentLogger = pino({ level: "silent" });

let hardhatNode: HardhatNode;

before(async () => {
  hardhatNode = await startHardhatNode();
});

after(() => {
  hardhatNode.stop();
});

async function fetchHealth(port: number) {
  const res = await fetch(`http://localhost:${port}/health`);
  return { status: res.status, body: await res.json() };
}

describe("HealthCheck", () => {
  it("returns correct JSON structure on GET /health", async () => {
    const { clients, contracts } = await loadFixture(deployWithCollateralFixture);
    const config = createKeeperConfig(contracts.perpsAddress);
    config.healthPort = 0; // auto-assign

    const tracker = new PositionTracker(clients.publicClient, config, silentLogger);
    const liquidator = new Liquidator(
      clients.publicClient,
      clients.keeperWallet,
      clients.keeperWallet.account,
      tracker,
      config,
      silentLogger,
    );

    await tracker.start();
    await liquidator.start();

    // Use a fixed port for the test
    config.healthPort = 18901;
    const health = new HealthCheck(tracker, liquidator, config, silentLogger);
    health.start();
    await sleep(100);

    try {
      const { status, body } = await fetchHealth(18901);
      assert.equal(status, 200);
      assert.equal(body.status, "running");
      assert.equal(typeof body.trackedPositions, "number");
      assert.equal(typeof body.liquidationsExecuted, "number");
      assert.equal(typeof body.uptimeSeconds, "number");
      assert.equal(typeof body.dryRun, "boolean");
      assert.ok("lastPrice" in body);
      assert.ok("lastPriceCheckAt" in body);
    } finally {
      health.stop();
      liquidator.stop();
      tracker.stop();
    }
  });

  it("returns 404 for non-health endpoints", async () => {
    const { clients, contracts } = await loadFixture(deployWithCollateralFixture);
    const config = createKeeperConfig(contracts.perpsAddress);
    config.healthPort = 18902;

    const tracker = new PositionTracker(clients.publicClient, config, silentLogger);
    const liquidator = new Liquidator(
      clients.publicClient,
      clients.keeperWallet,
      clients.keeperWallet.account,
      tracker,
      config,
      silentLogger,
    );

    await tracker.start();
    await liquidator.start();

    const health = new HealthCheck(tracker, liquidator, config, silentLogger);
    health.start();
    await sleep(100);

    try {
      const res = await fetch("http://localhost:18902/other");
      assert.equal(res.status, 404);
    } finally {
      health.stop();
      liquidator.stop();
      tracker.stop();
    }
  });

  it("reflects tracked position count", async () => {
    const {
      clients,
      contracts,
      config: deployConfig,
    } = await loadFixture(deployWithCollateralFixture);

    const marketPrice = await clients.publicClient.readContract({
      address: contracts.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      functionName: "getMarketPrice",
    });
    const qty = parseUnits("1", deployConfig.quantityDecimals);
    const perps = getContract({
      address: contracts.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      client: clients.publicClient,
    });
    await perps.write.createOrder([marketPrice, -qty], { account: clients.sellerWallet.account });
    await perps.write.createOrder([marketPrice, qty], { account: clients.buyerWallet.account });

    const config = createKeeperConfig(contracts.perpsAddress);
    config.healthPort = 18903;

    const tracker = new PositionTracker(clients.publicClient, config, silentLogger);
    const liquidator = new Liquidator(
      clients.publicClient,
      clients.keeperWallet,
      clients.keeperWallet.account,
      tracker,
      config,
      silentLogger,
    );

    await tracker.start();
    await liquidator.start();

    const health = new HealthCheck(tracker, liquidator, config, silentLogger);
    health.start();
    await sleep(100);

    try {
      const { body } = await fetchHealth(18903);
      assert.equal(body.trackedPositions, 2);
    } finally {
      health.stop();
      liquidator.stop();
      tracker.stop();
    }
  });

  it("reflects liquidation stats after a liquidation", async () => {
    const { clients, contracts, makeLiquidatable } = await loadFixture(
      deployWithLiquidatablePositionFixture,
    );

    const config = createKeeperConfig(contracts.perpsAddress);
    config.healthPort = 18904;

    const tracker = new PositionTracker(clients.publicClient, config, silentLogger);
    const liquidator = new Liquidator(
      clients.publicClient,
      clients.keeperWallet,
      clients.keeperWallet.account,
      tracker,
      config,
      silentLogger,
    );

    await tracker.start();
    await liquidator.start();

    const health = new HealthCheck(tracker, liquidator, config, silentLogger);
    health.start();
    await sleep(100);

    try {
      const before = await fetchHealth(18904);
      assert.equal(before.body.liquidationsExecuted, 0);

      await makeLiquidatable();

      await waitFor(async () => {
        const { body } = await fetchHealth(18904);
        return body.liquidationsExecuted > 0;
      }, 10_000);

      const after = await fetchHealth(18904);
      assert.ok(after.body.liquidationsExecuted >= 1);
    } finally {
      health.stop();
      liquidator.stop();
      tracker.stop();
    }
  });
});
