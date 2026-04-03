import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { encodeFunctionData, maxUint256 } from "viem";
import type { NetworkConnection } from "hardhat/types/network";
import {
  defaultSeries,
  INITIAL_PRICE_E8,
  ORACLE_DECIMALS,
} from "./optionsFixtures.ts";

const { viem, networkHelpers } = await network.connect();

const LOT = BigInt(defaultSeries.lotSize);
const LIMIT = 0;

// ── Fixture ─────────────────────────────────────────────────────────────

async function deployPerpsIntegrationFixture(conn: NetworkConnection) {
  const { viem: v, networkHelpers: nh } = conn;
  const [owner] = await v.getWalletClients();

  // ── Registry ──────────────────────────────────────────────────────────
  const registryImpl = await v.deployContract(
    "contracts/OptionMarketRegistry.sol:OptionMarketRegistry",
    [],
  );
  const registryProxy = await v.deployContract("ERC1967Proxy", [
    registryImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: registryImpl.abi,
      functionName: "initialize",
      args: [],
    }),
  ]);
  const registry = await v.getContractAt("OptionMarketRegistry", registryProxy.address);

  // ── Mocks ─────────────────────────────────────────────────────────────
  const usdc = await v.deployContract("contracts/USDCMock.sol:USDCMock", []);
  const oracle = await v.deployContract(
    "contracts/PriceOracleMock.sol:PriceOracleMock",
    [INITIAL_PRICE_E8, ORACLE_DECIMALS],
  );

  // ── MarginEngine ──────────────────────────────────────────────────────
  const engineImpl = await v.deployContract(
    "contracts/OptionMarginEngine.sol:OptionMarginEngine",
    [],
  );
  const engineProxy = await v.deployContract("ERC1967Proxy", [
    engineImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: engineImpl.abi,
      functionName: "initialize",
      args: [registry.address, usdc.address, oracle.address],
    }),
  ]);
  const engine = await v.getContractAt("OptionMarginEngine", engineProxy.address);

  // ── PerpsDEXMock ──────────────────────────────────────────────────────
  const perpsMock = await v.deployContract("contracts/PerpsDEXMock.sol:PerpsDEXMock", []);

  // Link perps to engine
  await engine.write.setPerpsDex([perpsMock.address], { account: owner.account });

  // ── OrderBook + Router (for creating option positions) ────────────────
  const bookImpl = await v.deployContract(
    "contracts/OptionOrderBook.sol:OptionOrderBook",
    [],
  );
  const bookProxy = await v.deployContract("ERC1967Proxy", [
    bookImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: bookImpl.abi,
      functionName: "initialize",
      args: [registry.address],
    }),
  ]);
  const book = await v.getContractAt("OptionOrderBook", bookProxy.address);

  const routerImpl = await v.deployContract(
    "contracts/OptionMatchingRouter.sol:OptionMatchingRouter",
    [],
  );
  const routerProxy = await v.deployContract("ERC1967Proxy", [
    routerImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: routerImpl.abi,
      functionName: "initialize",
      args: [registry.address, book.address, engine.address],
    }),
  ]);
  const router = await v.getContractAt("OptionMatchingRouter", routerProxy.address);

  await book.write.setRouter([router.address], { account: owner.account });
  await engine.write.setRouter([router.address], { account: owner.account });

  // ── Create series ─────────────────────────────────────────────────────
  const latest = BigInt(await nh.time.latest());
  const expiry = latest + 604800n;

  await registry.write.createSeries(
    [
      defaultSeries.strikeE8,
      expiry,
      defaultSeries.isCall,
      defaultSeries.tickSizeE8,
      defaultSeries.lotSize,
      defaultSeries.initialIV,
    ],
    { account: owner.account },
  );
  const seriesId = 1n;

  // ── Fund traders ──────────────────────────────────────────────────────
  const wallets = await v.getWalletClients();
  const trader1 = wallets[3]!;
  const trader2 = wallets[4]!;

  const depositAmount = 50_000_000_000n; // 50k USDC
  for (const w of [trader1, trader2]) {
    await usdc.write.transfer([w.account.address, depositAmount * 2n], { account: owner.account });
    const usdcAs = await v.getContractAt("USDCMock", usdc.address, { client: { wallet: w } });
    await usdcAs.write.approve([engine.address, maxUint256]);
    const eng = await v.getContractAt("OptionMarginEngine", engine.address, {
      client: { wallet: w },
    });
    await eng.write.deposit([depositAmount]);
  }

  return {
    registry,
    book,
    engine,
    router,
    perpsMock,
    oracle,
    usdc,
    seriesId,
    traders: { trader1, trader2 },
    accounts: { owner },
  };
}

async function deployNoPerpsFixture(conn: NetworkConnection) {
  const { viem: v } = conn;
  const [owner] = await v.getWalletClients();
  const wallets = await v.getWalletClients();
  const trader1 = wallets[3]!;

  const registryImpl = await v.deployContract(
    "contracts/OptionMarketRegistry.sol:OptionMarketRegistry",
    [],
  );
  const registryProxy = await v.deployContract("ERC1967Proxy", [
    registryImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: registryImpl.abi,
      functionName: "initialize",
      args: [],
    }),
  ]);
  const registry = await v.getContractAt("OptionMarketRegistry", registryProxy.address);

  const usdc = await v.deployContract("contracts/USDCMock.sol:USDCMock", []);
  const oracle = await v.deployContract(
    "contracts/PriceOracleMock.sol:PriceOracleMock",
    [INITIAL_PRICE_E8, ORACLE_DECIMALS],
  );

  const engineImpl = await v.deployContract(
    "contracts/OptionMarginEngine.sol:OptionMarginEngine",
    [],
  );
  const engineProxy = await v.deployContract("ERC1967Proxy", [
    engineImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: engineImpl.abi,
      functionName: "initialize",
      args: [registry.address, usdc.address, oracle.address],
    }),
  ]);
  const engine = await v.getContractAt("OptionMarginEngine", engineProxy.address);

  return { engine, traders: { trader1 } };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("Level 1 Perps Integration", () => {
  describe("admin", () => {
    it("setPerpsDex links the perps DEX", async () => {
      const { engine, perpsMock } = await networkHelpers.loadFixture(
        deployPerpsIntegrationFixture,
      );

      const linked = await engine.read.perpsDex();
      assert.equal(linked.toLowerCase(), perpsMock.address.toLowerCase());
    });
  });

  describe("getPerpPosition", () => {
    it("returns zero when no perps position", async () => {
      const { engine, traders } = await networkHelpers.loadFixture(
        deployPerpsIntegrationFixture,
      );

      const [qty, entry] = await engine.read.getPerpPosition([traders.trader1.account.address]);
      assert.equal(qty, 0n);
      assert.equal(entry, 0n);
    });

    it("reads perps position from mock DEX", async () => {
      const { engine, perpsMock, traders } = await networkHelpers.loadFixture(
        deployPerpsIntegrationFixture,
      );

      // Simulate a 2-lot long perp position at $50,000 entry
      await perpsMock.write.setUserPosition([
        traders.trader1.account.address,
        2_000_000n, // 2 lots (QUANTITY_DECIMALS=6)
        50000_000_000n, // $50,000 entry (token decimals)
      ]);

      const [qty, entry] = await engine.read.getPerpPosition([traders.trader1.account.address]);
      assert.equal(qty, 2_000_000n);
      assert.equal(entry, 50000_000_000n);
    });
  });

  describe("getPerpCollateral", () => {
    it("returns zero when no perps collateral", async () => {
      const { engine, traders } = await networkHelpers.loadFixture(
        deployPerpsIntegrationFixture,
      );

      const col = await engine.read.getPerpCollateral([traders.trader1.account.address]);
      assert.equal(col, 0n);
    });

    it("reads perps collateral from mock DEX", async () => {
      const { engine, perpsMock, traders } = await networkHelpers.loadFixture(
        deployPerpsIntegrationFixture,
      );

      await perpsMock.write.setBalance([
        traders.trader1.account.address,
        10_000_000_000n, // 10k USDC
      ]);

      const col = await engine.read.getPerpCollateral([traders.trader1.account.address]);
      assert.equal(col, 10_000_000_000n);
    });
  });

  describe("getPortfolioOverview", () => {
    it("returns options-only data when no perps exposure", async () => {
      const { engine, traders } = await networkHelpers.loadFixture(
        deployPerpsIntegrationFixture,
      );

      const p = await engine.read.getPortfolioOverview([traders.trader1.account.address]);

      // Options collateral = deposit amount in WAD
      const expectedWad = 50_000_000_000n * 10n ** 12n;
      assert.equal(p.optionsCollateral, expectedWad);
      assert.equal(p.optionsIM, 0n, "no options positions → IM = 0");
      assert.equal(p.optionsMM, 0n);
      assert.equal(p.optionsReserved, 0n);
      assert.equal(p.activeSeriesCount, 0n);

      // Perps fields are zero (mock has no state set)
      assert.equal(p.perpCollateral, 0n);
      assert.equal(p.perpNetQuantity, 0n);
      assert.equal(p.perpUnrealizedPnl, 0n);
      assert.equal(p.perpIM, 0n);
      assert.equal(p.perpMM, 0n);
      assert.equal(p.perpIsLiquidatable, false);
    });

    it("returns combined options + perps data", async () => {
      const { engine, router, perpsMock, traders, seriesId } = await networkHelpers.loadFixture(
        deployPerpsIntegrationFixture,
      );

      // Create an option position: trader2 sells, trader1 buys
      await router.write.submitOrder(
        [{ seriesId, isBuy: false, priceTicks: 100n, size: LOT, orderType: LIMIT, postOnly: false, reduceOnly: false }],
        { account: traders.trader2.account },
      );
      await router.write.submitOrder(
        [{ seriesId, isBuy: true, priceTicks: 100n, size: LOT, orderType: LIMIT, postOnly: false, reduceOnly: false }],
        { account: traders.trader1.account },
      );

      // Simulate perps exposure on the mock
      await perpsMock.write.setUserPosition([
        traders.trader1.account.address,
        -1_000_000n, // 1 lot short perp
        52000_000_000n, // entry at $52,000
      ]);
      await perpsMock.write.setBalance([traders.trader1.account.address, 20_000_000_000n]);
      await perpsMock.write.setUnrealizedPnl([traders.trader1.account.address, 1_500_000_000n]); // +$1,500
      await perpsMock.write.setMargins([
        traders.trader1.account.address,
        5_000_000_000n, // perp IM
        3_000_000_000n, // perp MM
      ]);

      const p = await engine.read.getPortfolioOverview([traders.trader1.account.address]);

      // Options: trader1 is long, so IM = 0 (longs need no margin)
      assert.equal(p.optionsIM, 0n, "long option position has no ongoing margin");
      assert.equal(p.activeSeriesCount, 1n);

      // Perps
      assert.equal(p.perpCollateral, 20_000_000_000n);
      assert.equal(p.perpNetQuantity, -1_000_000n);
      assert.equal(p.perpUnrealizedPnl, 1_500_000_000n);
      assert.equal(p.perpIM, 5_000_000_000n);
      assert.equal(p.perpMM, 3_000_000_000n);
      assert.equal(p.perpIsLiquidatable, false);
    });

    it("shows perp liquidation risk", async () => {
      const { engine, perpsMock, traders } = await networkHelpers.loadFixture(
        deployPerpsIntegrationFixture,
      );

      // Simulate underwater perps position
      await perpsMock.write.setUserPosition([
        traders.trader1.account.address,
        -5_000_000n, // 5 lots short
        50000_000_000n,
      ]);
      await perpsMock.write.setBalance([traders.trader1.account.address, 1_000_000n]); // $1 left
      await perpsMock.write.setMargins([
        traders.trader1.account.address,
        10_000_000_000n,
        8_000_000_000n, // MM = $8k, balance = $1 → liquidatable
      ]);

      const p = await engine.read.getPortfolioOverview([traders.trader1.account.address]);
      assert.equal(p.perpIsLiquidatable, true, "perps should be flagged as liquidatable");
    });
  });

  describe("margin isolation", () => {
    it("options margin does not affect perps collateral", async () => {
      const { engine, router, perpsMock, traders, seriesId } = await networkHelpers.loadFixture(
        deployPerpsIntegrationFixture,
      );

      // Set perps collateral before any option trading
      await perpsMock.write.setBalance([traders.trader1.account.address, 30_000_000_000n]);

      // Trade options — this only affects _collateral[user] in the engine, not perps
      await router.write.submitOrder(
        [{ seriesId, isBuy: false, priceTicks: 100n, size: LOT, orderType: LIMIT, postOnly: false, reduceOnly: false }],
        { account: traders.trader2.account },
      );
      await router.write.submitOrder(
        [{ seriesId, isBuy: true, priceTicks: 100n, size: LOT, orderType: LIMIT, postOnly: false, reduceOnly: false }],
        { account: traders.trader1.account },
      );

      // Perps collateral unchanged
      const perpCol = await engine.read.getPerpCollateral([traders.trader1.account.address]);
      assert.equal(perpCol, 30_000_000_000n, "perps collateral should not be touched by options trading");

      // Options collateral decreased by premium
      const optCol = await engine.read.getCollateral([traders.trader1.account.address]);
      const expectedOptCol = 50_000_000_000n * 10n ** 12n; // initial deposit in WAD
      assert.ok(optCol < expectedOptCol, "options collateral should decrease from premium paid");
    });

    it("perps position does not affect options margin calculation", async () => {
      const { engine, router, perpsMock, traders, seriesId } = await networkHelpers.loadFixture(
        deployPerpsIntegrationFixture,
      );

      // Create a short option position for trader1
      await router.write.submitOrder(
        [{ seriesId, isBuy: true, priceTicks: 100n, size: LOT, orderType: LIMIT, postOnly: false, reduceOnly: false }],
        { account: traders.trader2.account },
      );
      await router.write.submitOrder(
        [{ seriesId, isBuy: false, priceTicks: 100n, size: LOT, orderType: LIMIT, postOnly: false, reduceOnly: false }],
        { account: traders.trader1.account },
      );

      const imBefore = await engine.read.computeAccountIM([traders.trader1.account.address]);

      // Add a huge perp position — should NOT change options IM
      await perpsMock.write.setUserPosition([
        traders.trader1.account.address,
        100_000_000n, // 100 lots long
        50000_000_000n,
      ]);
      await perpsMock.write.setBalance([traders.trader1.account.address, 500_000_000_000n]);

      const imAfter = await engine.read.computeAccountIM([traders.trader1.account.address]);
      // Allow tiny drift from block.timestamp advancing between calls (changes tSec in Greeks)
      const drift = imAfter > imBefore ? imAfter - imBefore : imBefore - imAfter;
      const tolerance = imBefore / 10000n; // 0.01%
      assert.ok(drift <= tolerance, `options IM drift ${drift} exceeds tolerance ${tolerance}`);
    });
  });

  describe("no perps linked", () => {
    it("returns zeros when perpsDex is not set", async () => {
      const { engine, traders } = await networkHelpers.loadFixture(
        deployNoPerpsFixture,
      );

      const [qty, entry] = await engine.read.getPerpPosition([traders.trader1.account.address]);
      assert.equal(qty, 0n);
      assert.equal(entry, 0n);

      const col = await engine.read.getPerpCollateral([traders.trader1.account.address]);
      assert.equal(col, 0n);

      const p = await engine.read.getPortfolioOverview([traders.trader1.account.address]);
      assert.equal(p.perpCollateral, 0n);
      assert.equal(p.perpNetQuantity, 0n);
      assert.equal(p.perpIsLiquidatable, false);
    });
  });
});
