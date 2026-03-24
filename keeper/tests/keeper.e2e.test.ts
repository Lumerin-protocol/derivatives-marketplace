import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getAddress, getContract, parseUnits, type Address } from "viem";
import pino from "pino";

import { PositionTracker } from "../src/positionTracker.ts";
import { Liquidator } from "../src/liquidator.ts";
import type { Config } from "../src/config.ts";
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
import { hashPowerPerpsDexAbi, priceOracleMockAbi } from "../src/abi.ts";

const silentLogger = pino({ level: "silent" });

let hardhatNode: HardhatNode;

before(async () => {
  hardhatNode = await startHardhatNode();
});

after(() => {
  hardhatNode.stop();
});

// ── PositionTracker tests ────────────────────────────────────────────────────

describe("PositionTracker", () => {
  let deployment: Awaited<ReturnType<typeof deployWithCollateralFixture>>;
  let tracker: PositionTracker;
  let perps: typeof deployment.contracts.perps;
  let marketPrice: bigint;
  let qty: bigint;

  beforeEach(async () => {
    deployment = await loadFixture(deployWithCollateralFixture);
    const { clients, contracts, config: dc } = deployment;

    marketPrice = (await clients.publicClient.readContract({
      address: contracts.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      functionName: "getMarketPrice",
    })) as bigint;
    qty = parseUnits("1", dc.quantityDecimals);

    perps = deployment.contracts.perps;
  });

  afterEach(() => {
    tracker?.stop();
  });

  async function startTracker() {
    const config = createKeeperConfig(deployment.contracts.perpsAddress);
    tracker = new PositionTracker(deployment.clients.publicClient, config, silentLogger);
    await tracker.start();
    return tracker;
  }

  async function openPositions() {
    const { sellerWallet, buyerWallet } = deployment.clients;
    await perps.write.createOrder([marketPrice, -qty], { account: sellerWallet.account });
    await perps.write.createOrder([marketPrice, qty], { account: buyerWallet.account });
  }

  it("should start with zero tracked users when no positions exist", async () => {
    await startTracker();
    assert.equal(tracker.getUsers().size, 0);
  });

  it("should sync existing positions on start", async () => {
    await openPositions();
    await startTracker();

    assert.equal(tracker.getUsers().size, 2);

    const sellerState = tracker
      .getUsers()
      .get(getAddress(deployment.clients.sellerWallet.account.address));
    assert.ok(sellerState, "Seller should be tracked");
    assert.ok(sellerState.netQuantity < 0n, "Seller should be short");

    const buyerState = tracker
      .getUsers()
      .get(getAddress(deployment.clients.buyerWallet.account.address));
    assert.ok(buyerState, "Buyer should be tracked");
    assert.ok(buyerState.netQuantity > 0n, "Buyer should be long");
  });

  it("should detect new positions via events", async () => {
    await startTracker();
    assert.equal(tracker.getUsers().size, 0);

    await openPositions();
    await waitFor(() => tracker.getUsers().size === 2, 5_000);

    assert.equal(tracker.getUsers().size, 2);
  });

  it("should compute correct liquidation prices", async () => {
    const { sellerWallet, buyerWallet } = deployment.clients;
    const minCollateral = deployment.getMinimumCollateral(marketPrice, qty);

    await perps.write.removeCollateral([deployment.config.collateralPerUser - minCollateral], {
      account: sellerWallet.account,
    });
    await perps.write.removeCollateral([deployment.config.collateralPerUser - minCollateral], {
      account: buyerWallet.account,
    });

    await openPositions();
    await startTracker();

    const sellerState = tracker.getUsers().get(getAddress(sellerWallet.account.address));
    assert.ok(sellerState);
    assert.ok(sellerState.liquidationPrice > 0n, "Short should have positive liq price");
    assert.ok(sellerState.liquidationPrice > marketPrice, "Short liq price should be above market");

    const buyerState = tracker.getUsers().get(getAddress(buyerWallet.account.address));
    assert.ok(buyerState);
    assert.ok(buyerState.liquidationPrice > 0n, "Long should have positive liq price");
    assert.ok(buyerState.liquidationPrice < marketPrice, "Long liq price should be below market");
  });

  it("should update collateral and liquidation price on addCollateral", async () => {
    const { sellerWallet } = deployment.clients;
    const minCollateral = deployment.getMinimumCollateral(marketPrice, qty);

    // Keep tight collateral so liq price is meaningful, leave USDC in wallet to add back later
    const keepInContract = minCollateral * 2n;
    await perps.write.removeCollateral([deployment.config.collateralPerUser - keepInContract], {
      account: sellerWallet.account,
    });

    await openPositions();
    await startTracker();

    const sellerAddr = getAddress(sellerWallet.account.address);
    const before = tracker.getUsers().get(sellerAddr)!;
    const liqPriceBefore = before.liquidationPrice;
    const collateralBefore = before.collateral;

    const addAmount = parseUnits("50", deployment.config.tokenDecimals);
    await perps.write.addCollateral([addAmount], { account: sellerWallet.account });

    await waitFor(() => {
      const user = tracker.getUsers().get(sellerAddr);
      return user != null && user.collateral > collateralBefore;
    }, 5_000);

    const updated = tracker.getUsers().get(sellerAddr)!;
    assert.ok(updated.collateral > collateralBefore, "Collateral should increase");
    assert.ok(
      updated.liquidationPrice > liqPriceBefore,
      "Short liq price should increase (further from market) with more collateral",
    );
  });

  it("should update collateral and liquidation price on removeCollateral", async () => {
    const { buyerWallet } = deployment.clients;

    await openPositions();
    await startTracker();

    const buyerAddr = getAddress(buyerWallet.account.address);
    const before = tracker.getUsers().get(buyerAddr)!;
    const liqPriceBefore = before.liquidationPrice;
    const collateralBefore = before.collateral;

    const removeAmount = parseUnits("50", deployment.config.tokenDecimals);
    await perps.write.removeCollateral([removeAmount], { account: buyerWallet.account });

    await waitFor(() => {
      const user = tracker.getUsers().get(buyerAddr);
      return user != null && user.collateral < collateralBefore;
    }, 5_000);

    const updated = tracker.getUsers().get(buyerAddr)!;
    assert.ok(updated.collateral < collateralBefore, "Collateral should decrease");
    assert.ok(
      updated.liquidationPrice > liqPriceBefore,
      "Long liq price should increase (closer to market) with less collateral",
    );
  });

  it("should remove user when position is fully closed", async () => {
    const { sellerWallet, buyerWallet } = deployment.clients;

    await openPositions();
    await startTracker();
    assert.equal(tracker.getUsers().size, 2);

    // Close positions by trading in the opposite direction
    await perps.write.createOrder([marketPrice, qty], { account: sellerWallet.account });
    await perps.write.createOrder([marketPrice, -qty], { account: buyerWallet.account });

    await waitFor(() => tracker.getUsers().size === 0, 5_000);
    assert.equal(tracker.getUsers().size, 0, "All users should be removed after closing positions");
  });

  it("should track three users simultaneously", async () => {
    const { sellerWallet, buyerWallet, buyer2Wallet } = deployment.clients;

    await perps.write.createOrder([marketPrice, -(qty * 2n)], { account: sellerWallet.account });
    await perps.write.createOrder([marketPrice, qty], { account: buyerWallet.account });
    await perps.write.createOrder([marketPrice, qty], { account: buyer2Wallet.account });

    await startTracker();
    assert.equal(tracker.getUsers().size, 3);

    const seller = tracker.getUsers().get(getAddress(sellerWallet.account.address));
    const buyer = tracker.getUsers().get(getAddress(buyerWallet.account.address));
    const buyer2 = tracker.getUsers().get(getAddress(buyer2Wallet.account.address));

    assert.ok(seller && seller.netQuantity < 0n);
    assert.ok(buyer && buyer.netQuantity > 0n);
    assert.ok(buyer2 && buyer2.netQuantity > 0n);
  });

  it("should correct state after resync", async () => {
    const { sellerWallet } = deployment.clients;

    await openPositions();
    await startTracker();
    assert.equal(tracker.getUsers().size, 2);

    await tracker.resync();
    assert.equal(tracker.getUsers().size, 2);

    const sellerState = tracker.getUsers().get(getAddress(sellerWallet.account.address));
    assert.ok(sellerState);
    assert.ok(sellerState.netQuantity < 0n);
    assert.ok(sellerState.collateral > 0n);
    assert.ok(sellerState.liquidationPrice > 0n);
  });

  it("should track position updates when size changes", async () => {
    const { sellerWallet, buyer2Wallet } = deployment.clients;

    await openPositions();
    await startTracker();

    const sellerAddr = getAddress(sellerWallet.account.address);
    const qtyBefore = tracker.getUsers().get(sellerAddr)!.netQuantity;

    // Seller opens a bigger short position (buyer2 takes the other side)
    await perps.write.createOrder([marketPrice, -qty], { account: sellerWallet.account });
    await perps.write.createOrder([marketPrice, qty], { account: buyer2Wallet.account });

    await waitFor(() => {
      const user = tracker.getUsers().get(sellerAddr);
      return user != null && user.netQuantity !== qtyBefore;
    }, 5_000);

    const updated = tracker.getUsers().get(sellerAddr)!;
    assert.ok(updated.netQuantity < qtyBefore, "Short should be larger (more negative)");
  });

  it("should populate all fields of UserState correctly", async () => {
    const { sellerWallet, buyerWallet } = deployment.clients;
    const minCollateral = deployment.getMinimumCollateral(marketPrice, qty);

    // Use tight collateral so liquidation price is meaningful (not 0)
    await perps.write.removeCollateral([deployment.config.collateralPerUser - minCollateral * 2n], {
      account: buyerWallet.account,
    });
    await perps.write.removeCollateral([deployment.config.collateralPerUser - minCollateral * 2n], {
      account: sellerWallet.account,
    });

    await openPositions();
    await startTracker();

    const buyerAddr = getAddress(buyerWallet.account.address);
    const user = tracker.getUsers().get(buyerAddr)!;

    assert.equal(user.address, buyerAddr);
    assert.ok(user.netQuantity > 0n, "Should be long");
    assert.ok(user.entryPrice > 0n, "Entry price should be set");
    assert.ok(user.collateral > 0n, "Collateral should be positive");
    assert.equal(user.isLong, true);
    assert.ok(user.orderMargin >= 0n, "Order margin should be non-negative");
    assert.ok(user.liquidationPrice > 0n, "Liquidation price should be positive");
  });
});

// ── Liquidator tests ─────────────────────────────────────────────────────────

describe("Liquidator", () => {
  let deployment: Awaited<ReturnType<typeof deployWithLiquidatablePositionFixture>>;
  let tracker: PositionTracker;
  let liquidator: Liquidator;
  let config: Config;

  beforeEach(async () => {
    deployment = await loadFixture(deployWithLiquidatablePositionFixture);
    const { clients, contracts } = deployment;
    config = createKeeperConfig(contracts.perpsAddress);
    tracker = new PositionTracker(clients.publicClient, config, silentLogger);
    liquidator = new Liquidator(
      clients.publicClient,
      clients.keeperWallet,
      clients.keeperWallet.account,
      tracker,
      config,
      silentLogger,
    );
    await tracker.start();
    await liquidator.start();
  });

  afterEach(() => {
    liquidator?.stop();
    tracker?.stop();
  });

  function restartKeeper(configOverrides: Partial<Config>) {
    liquidator.stop();
    tracker.stop();
    const { clients, contracts } = deployment;
    config = { ...createKeeperConfig(contracts.perpsAddress), ...configOverrides };
    tracker = new PositionTracker(clients.publicClient, config, silentLogger);
    liquidator = new Liquidator(
      clients.publicClient,
      clients.keeperWallet,
      clients.keeperWallet.account,
      tracker,
      config,
      silentLogger,
    );
    return Promise.all([tracker.start(), liquidator.start()]);
  }

  async function getUserPosition(user: Address) {
    return (await deployment.clients.publicClient.readContract({
      address: deployment.contracts.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      functionName: "getUserPosition",
      args: [user],
    })) as { netQuantity: bigint };
  }

  it("should not liquidate healthy positions", async () => {
    await sleep(config.pollIntervalMs * 3);

    const position = await getUserPosition(deployment.clients.sellerWallet.account.address);
    assert.ok(position.netQuantity !== 0n, "Position should still exist");
    assert.equal(liquidator.stats.liquidationsExecuted, 0);
  });

  it("should liquidate when price crosses threshold", async () => {
    const sellerAddr = deployment.clients.sellerWallet.account.address;
    const posBefore = await getUserPosition(sellerAddr);
    assert.ok(posBefore.netQuantity !== 0n, "Seller should have a position");

    await deployment.makeLiquidatable();

    await waitFor(async () => {
      const pos = await getUserPosition(sellerAddr);
      return pos.netQuantity === 0n;
    }, 10_000);

    const posAfter = await getUserPosition(sellerAddr);
    assert.equal(posAfter.netQuantity, 0n, "Position should be liquidated");
    assert.ok(liquidator.stats.liquidationsExecuted >= 1);
  });

  it("should remove liquidated user from tracker", async () => {
    const sellerAddr = getAddress(deployment.clients.sellerWallet.account.address);
    assert.ok(tracker.getUsers().has(sellerAddr), "Seller should be tracked before liquidation");

    await deployment.makeLiquidatable();
    await waitFor(() => !tracker.getUsers().has(sellerAddr), 10_000);

    assert.ok(!tracker.getUsers().has(sellerAddr), "Seller should be removed after liquidation");
  });

  it("should track stats correctly (lastPrice, lastCheckAt)", async () => {
    await sleep(config.pollIntervalMs * 2);

    assert.ok(liquidator.stats.lastPrice > 0n, "lastPrice should be set after polling");
    assert.ok(liquidator.stats.lastCheckAt !== null, "lastCheckAt should be set");
    assert.ok(liquidator.stats.lastCheckAt instanceof Date, "lastCheckAt should be a Date");
  });

  it("should not execute in dry-run mode", async () => {
    await restartKeeper({ dryRun: true });

    await deployment.makeLiquidatable();
    await sleep(config.pollIntervalMs * 5);

    const position = await getUserPosition(deployment.clients.sellerWallet.account.address);
    assert.ok(position.netQuantity !== 0n, "Position should NOT be liquidated in dry-run");
    assert.equal(liquidator.stats.liquidationsExecuted, 0, "No liquidations in dry-run");
  });

  it("should skip liquidation when profit is below minProfitMargin", async () => {
    await restartKeeper({ minProfitMargin: parseUnits("999999999", 6) });

    await deployment.makeLiquidatable();
    await sleep(config.pollIntervalMs * 5);

    const position = await getUserPosition(deployment.clients.sellerWallet.account.address);
    assert.ok(position.netQuantity !== 0n, "Position should NOT be liquidated below profit margin");
    assert.equal(liquidator.stats.liquidationsExecuted, 0);
  });

  it("should liquidate long position when price drops", async () => {
    // Drop the price to make the buyer's long position liquidatable
    const oracle = getContract({
      address: deployment.contracts.oracleAddress,
      abi: priceOracleMockAbi,
      client: { wallet: deployment.clients.ownerWallet },
    });
    await oracle.write.setPrice([
      deployment.config.initialPrice / 3n,
      deployment.config.oracle.decimals,
    ]);

    // Resync tracker to pick up the new price
    await tracker.resync();

    const buyerAddr = deployment.clients.buyerWallet.account.address;

    await waitFor(async () => {
      const pos = await getUserPosition(buyerAddr);
      return pos.netQuantity === 0n;
    }, 10_000);

    const posAfter = await getUserPosition(buyerAddr);
    assert.equal(posAfter.netQuantity, 0n, "Long position should be liquidated");
    assert.ok(liquidator.stats.liquidationsExecuted >= 1);
  });

  it("should handle stop/restart cleanly", async () => {
    liquidator.stop();
    tracker.stop();

    // Restart — should not throw
    await restartKeeper({});

    await sleep(config.pollIntervalMs * 2);
    assert.ok(liquidator.stats.lastPrice > 0n, "Should be polling after restart");
  });

  it("should stop cleanly without errors when no positions exist", async () => {
    await sleep(config.pollIntervalMs * 2);

    liquidator.stop();
    tracker.stop();

    assert.equal(liquidator.stats.liquidationsExecuted, 0);
  });

  it("should batch-liquidate multiple users in a single multicall", async () => {
    const sellerAddr = deployment.clients.sellerWallet.account.address;
    const seller2Addr = deployment.clients.seller2Wallet.account.address;

    const posSeller = await getUserPosition(sellerAddr);
    const posSeller2 = await getUserPosition(seller2Addr);
    assert.ok(posSeller.netQuantity !== 0n, "Seller should have a position");
    assert.ok(posSeller2.netQuantity !== 0n, "Seller2 should have a position");

    await deployment.makeLiquidatable();
    await tracker.resync();

    await waitFor(async () => {
      const p1 = await getUserPosition(sellerAddr);
      const p2 = await getUserPosition(seller2Addr);
      return p1.netQuantity === 0n && p2.netQuantity === 0n;
    }, 15_000);

    const posAfter1 = await getUserPosition(sellerAddr);
    const posAfter2 = await getUserPosition(seller2Addr);
    assert.equal(posAfter1.netQuantity, 0n, "Seller should be liquidated");
    assert.equal(posAfter2.netQuantity, 0n, "Seller2 should be liquidated");
    assert.equal(liquidator.stats.liquidationsExecuted, 2);
  });
});
