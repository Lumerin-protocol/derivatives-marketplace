import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { getAddress, getContract, parseUnits } from "viem";
import pino from "pino";

import { PositionTracker } from "../src/positionTracker.ts";
import { Liquidator } from "../src/liquidator.ts";
import {
  startHardhatNode,
  createKeeperConfig,
  waitFor,
  sleep,
  type HardhatNode,
  loadFixture,
} from "./helpers.ts";
import { deployWithCollateralFixture, deployWithLiquidatablePositionFixture } from "./fixture.ts";
import { perpsSimpleAbi } from "../src/abi.ts";

const silentLogger = pino({ level: "silent" });

// ── Test suite ───────────────────────────────────────────────────────────────

let hardhatNode: HardhatNode;

before(async () => {
  hardhatNode = await startHardhatNode();
});

after(() => {
  hardhatNode.stop();
});

// ── PositionTracker tests ────────────────────────────────────────────────────

describe("PositionTracker", () => {
  it("should start with zero tracked users when no positions exist", async () => {
    const { clients, contracts } = await loadFixture(deployWithCollateralFixture);
    const config = createKeeperConfig(contracts.perpsAddress);
    const tracker = new PositionTracker(clients.publicClient, config, silentLogger);

    await tracker.start();
    try {
      assert.equal(tracker.getUsers().size, 0);
    } finally {
      tracker.stop();
    }
  });

  it("should sync existing positions on start", async () => {
    const {
      clients,
      contracts,
      config: deployConfig,
    } = await loadFixture(deployWithCollateralFixture);

    // Create matching orders to establish positions (seller short, buyer long)
    const marketPrice = await clients.publicClient.readContract({
      address: contracts.perpsAddress,
      abi: perpsSimpleAbi,
      functionName: "getMarketPrice",
    });
    const qty = parseUnits("1", deployConfig.quantityDecimals);

    const perps = getContract({
      address: contracts.perpsAddress,
      abi: perpsSimpleAbi,
      client: clients.publicClient,
    });

    await perps.write.createOrder([marketPrice, -qty], { account: clients.sellerWallet.account });
    await perps.write.createOrder([marketPrice, qty], { account: clients.buyerWallet.account });

    // Now start tracker — it should pick up the 2 positions
    const config = createKeeperConfig(contracts.perpsAddress);
    const tracker = new PositionTracker(clients.publicClient, config, silentLogger);

    await tracker.start();
    try {
      assert.equal(tracker.getUsers().size, 2);

      const sellerState = tracker.getUsers().get(getAddress(clients.sellerWallet.account.address));
      assert.ok(sellerState, "Seller should be tracked");
      assert.ok(sellerState.netQuantity < 0n, "Seller should be short");

      const buyerState = tracker.getUsers().get(getAddress(clients.buyerWallet.account.address));
      assert.ok(buyerState, "Buyer should be tracked");
      assert.ok(buyerState.netQuantity > 0n, "Buyer should be long");
    } finally {
      tracker.stop();
    }
  });

  it("should detect new positions via events", async () => {
    const {
      clients,
      contracts,
      config: deployConfig,
    } = await loadFixture(deployWithCollateralFixture);

    // Start tracker with no positions
    const config = createKeeperConfig(contracts.perpsAddress);
    const tracker = new PositionTracker(clients.publicClient, config, silentLogger);
    await tracker.start();

    try {
      assert.equal(tracker.getUsers().size, 0);

      // Create matching orders to establish new positions
      const marketPrice = await clients.publicClient.readContract({
        address: contracts.perpsAddress,
        abi: perpsSimpleAbi,
        functionName: "getMarketPrice",
      });
      const qty = parseUnits("1", deployConfig.quantityDecimals);

      const perps = getContract({
        address: contracts.perpsAddress,
        abi: perpsSimpleAbi,
        client: { public: clients.publicClient, wallet: clients.sellerWallet },
      });

      await perps.write.createOrder([marketPrice, -qty], {
        account: clients.sellerWallet.account,
      });
      await perps.write.createOrder([marketPrice, qty], { account: clients.buyerWallet.account });

      // Wait for tracker to pick up the events
      await waitFor(() => tracker.getUsers().size === 2, 5_000);

      assert.equal(tracker.getUsers().size, 2);
    } finally {
      tracker.stop();
    }
  });

  it("should compute correct liquidation prices", async () => {
    const {
      clients,
      contracts,
      config: deployConfig,
      getMinimumCollateral,
    } = await loadFixture(deployWithCollateralFixture);

    const marketPrice = (await clients.publicClient.readContract({
      address: contracts.perpsAddress,
      abi: perpsSimpleAbi,
      functionName: "getMarketPrice",
    })) as bigint;
    const qty = parseUnits("1", deployConfig.quantityDecimals);

    // Withdraw most collateral so positions have tight (meaningful) liquidation prices
    const minCollateral = getMinimumCollateral(marketPrice, qty);
    const perps = getContract({
      address: contracts.perpsAddress,
      abi: perpsSimpleAbi,
      client: { public: clients.publicClient, wallet: clients.sellerWallet },
    });

    // Remove excess collateral, keeping only enough for the position
    await perps.write.removeCollateral([deployConfig.collateralPerUser - minCollateral], {
      account: clients.sellerWallet.account,
    });
    await perps.write.removeCollateral([deployConfig.collateralPerUser - minCollateral], {
      account: clients.buyerWallet.account,
    });

    await perps.write.createOrder([marketPrice, -qty], { account: clients.sellerWallet.account });
    await perps.write.createOrder([marketPrice, qty], { account: clients.buyerWallet.account });

    const config = createKeeperConfig(contracts.perpsAddress);
    const tracker = new PositionTracker(clients.publicClient, config, silentLogger);
    await tracker.start();

    try {
      const sellerState = tracker.getUsers().get(getAddress(clients.sellerWallet.account.address));
      assert.ok(sellerState);
      assert.ok(sellerState.liquidationPrice > 0n, "Short should have positive liq price");
      assert.ok(
        sellerState.liquidationPrice > marketPrice,
        "Short liq price should be above market",
      );

      const buyerState = tracker.getUsers().get(getAddress(clients.buyerWallet.account.address));
      assert.ok(buyerState);
      assert.ok(buyerState.liquidationPrice > 0n, "Long should have positive liq price");
      assert.ok(buyerState.liquidationPrice < marketPrice, "Long liq price should be below market");
    } finally {
      tracker.stop();
    }
  });
});

// ── Liquidator tests ─────────────────────────────────────────────────────────

describe("Liquidator", () => {
  it("should not liquidate healthy positions", async () => {
    const deployment = await loadFixture(deployWithLiquidatablePositionFixture);
    const { clients, contracts } = deployment;
    const config = createKeeperConfig(contracts.perpsAddress);

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

    try {
      // Wait a few poll cycles
      await sleep(config.pollIntervalMs * 3);

      // Position should still exist (not liquidated)
      const position = (await clients.publicClient.readContract({
        address: contracts.perpsAddress,
        abi: perpsSimpleAbi,
        functionName: "getUserPosition",
        args: [clients.sellerWallet.account.address],
      })) as { netQuantity: bigint };

      assert.ok(position.netQuantity !== 0n, "Position should still exist");
      assert.equal(liquidator.stats.liquidationsExecuted, 0);
    } finally {
      liquidator.stop();
      tracker.stop();
    }
  });

  it("should liquidate when price crosses threshold", async () => {
    const { clients, contracts, makeLiquidatable } = await loadFixture(
      deployWithLiquidatablePositionFixture,
    );
    const config = createKeeperConfig(contracts.perpsAddress);

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

    try {
      // Verify seller has a position
      const posBefore = (await clients.publicClient.readContract({
        address: contracts.perpsAddress,
        abi: perpsSimpleAbi,
        functionName: "getUserPosition",
        args: [clients.sellerWallet.account.address],
      })) as { netQuantity: bigint };
      assert.ok(posBefore.netQuantity !== 0n, "Seller should have a position");

      // Move price to make seller liquidatable
      await makeLiquidatable();

      // Wait for the keeper to detect and execute liquidation
      await waitFor(async () => {
        const pos = (await clients.publicClient.readContract({
          address: contracts.perpsAddress,
          abi: perpsSimpleAbi,
          functionName: "getUserPosition",
          args: [clients.sellerWallet.account.address],
        })) as { netQuantity: bigint };
        return pos.netQuantity === 0n;
      }, 10_000);

      // Position should be cleared
      const posAfter = (await clients.publicClient.readContract({
        address: contracts.perpsAddress,
        abi: perpsSimpleAbi,
        functionName: "getUserPosition",
        args: [clients.sellerWallet.account.address],
      })) as { netQuantity: bigint };

      assert.equal(posAfter.netQuantity, 0n, "Position should be liquidated");
      assert.equal(liquidator.stats.liquidationsExecuted, 1);
    } finally {
      liquidator.stop();
      tracker.stop();
    }
  });

  it("should remove liquidated user from tracker", async () => {
    const { clients, contracts, makeLiquidatable } = await loadFixture(
      deployWithLiquidatablePositionFixture,
    );

    const config = createKeeperConfig(contracts.perpsAddress);
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

    try {
      // Seller should be tracked
      assert.ok(
        tracker.getUsers().has(getAddress(clients.sellerWallet.account.address)),
        "Seller should be tracked before liquidation",
      );

      // Make liquidatable and wait for execution
      await makeLiquidatable();
      await waitFor(
        () => !tracker.getUsers().has(getAddress(clients.sellerWallet.account.address)),
        10_000,
      );

      assert.ok(
        !tracker.getUsers().has(getAddress(clients.sellerWallet.account.address)),
        "Seller should be removed from tracker after liquidation",
      );
    } finally {
      liquidator.stop();
      tracker.stop();
    }
  });
});
