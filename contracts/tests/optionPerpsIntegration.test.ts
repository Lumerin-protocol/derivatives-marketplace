import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { encodeFunctionData, maxUint256 } from "viem";
import type { NetworkConnection } from "hardhat/types/network";
import { defaultSeries, INITIAL_PRICE_E8, ORACLE_DECIMALS } from "./optionsFixtures.ts";

const { viem, networkHelpers } = await network.connect();

const LOT = BigInt(defaultSeries.lotSize);
const LIMIT = 0;

// ── Fixture ─────────────────────────────────────────────────────────────

async function deployPerpsIntegrationFixture(conn: NetworkConnection) {
  const { viem: v, networkHelpers: nh } = conn;
  const [owner] = await v.getWalletClients();

  // ── Registry ──────────────────────────────────────────────────────────
  const registryImpl = await v.deployContract("OptionMarketRegistry", []);
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
  const usdc = await v.deployContract("USDCMock", []);
  const oracle = await v.deployContract("PriceOracleMock", [INITIAL_PRICE_E8, ORACLE_DECIMALS]);

  // ── Vault ─────────────────────────────────────────────────────────────
  const vaultImpl = await v.deployContract("CollateralVault", []);
  const vaultProxy = await v.deployContract("ERC1967Proxy", [
    vaultImpl.address as `0x${string}`,
    encodeFunctionData({ abi: vaultImpl.abi, functionName: "initialize", args: [usdc.address] }),
  ]);
  const vault = await v.getContractAt("CollateralVault", vaultProxy.address);

  // ── MarginEngine (with vault) ─────────────────────────────────────────
  const engineImpl = await v.deployContract("OptionMarginEngine", []);
  const engineProxy = await v.deployContract("ERC1967Proxy", [
    engineImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: engineImpl.abi,
      functionName: "initialize",
      args: [registry.address, usdc.address, oracle.address, vault.address],
    }),
  ]);
  const engine = await v.getContractAt("OptionMarginEngine", engineProxy.address);

  // ── PerpsDEXMock ──────────────────────────────────────────────────────
  const perpsMock = await v.deployContract("PerpsDEXMock", []);
  // PME reads spot from perpsDex.getMarketPrice() — set to match oracle
  await perpsMock.write.setMarketPrice([50_000_000_000n]);

  // ── PME ───────────────────────────────────────────────────────────────
  const pmeImpl = await v.deployContract("PortfolioMarginEngine", []);
  const pmeProxy = await v.deployContract("ERC1967Proxy", [
    pmeImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: pmeImpl.abi,
      functionName: "initialize",
      args: [vault.address, perpsMock.address, engine.address],
    }),
  ]);
  const pme = await v.getContractAt("PortfolioMarginEngine", pmeProxy.address);

  // ── Wiring ────────────────────────────────────────────────────────────
  await vault.write.setMarginEngine([pme.address]);
  await vault.write.setAuthorizedCaller([engine.address, true]);
  await engine.write.setPortfolioMargin([pme.address], { account: owner.account });
  await engine.write.setPerpsDex([perpsMock.address], { account: owner.account });

  // ── OrderBook + Router ────────────────────────────────────────────────
  const bookImpl = await v.deployContract("OptionOrderBook", []);
  const bookProxy = await v.deployContract("ERC1967Proxy", [
    bookImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: bookImpl.abi,
      functionName: "initialize",
      args: [registry.address],
    }),
  ]);
  const book = await v.getContractAt("OptionOrderBook", bookProxy.address);

  const routerImpl = await v.deployContract("OptionMatchingRouter", []);
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

  // ── Fund traders (approve vault) ──────────────────────────────────────
  const wallets = await v.getWalletClients();
  const trader1 = wallets[3]!;
  const trader2 = wallets[4]!;

  const depositAmount = 50_000_000_000n; // 50k USDC
  for (const w of [trader1, trader2]) {
    await usdc.write.transfer([w.account.address, depositAmount * 2n], { account: owner.account });
    const usdcAs = await v.getContractAt("USDCMock", usdc.address, { client: { wallet: w } });
    await usdcAs.write.approve([vault.address, maxUint256]);
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
    vault,
    pme,
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

  const registryImpl = await v.deployContract("OptionMarketRegistry", []);
  const registryProxy = await v.deployContract("ERC1967Proxy", [
    registryImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: registryImpl.abi,
      functionName: "initialize",
      args: [],
    }),
  ]);
  const registry = await v.getContractAt("OptionMarketRegistry", registryProxy.address);

  const usdc = await v.deployContract("USDCMock", []);
  const oracle = await v.deployContract("PriceOracleMock", [INITIAL_PRICE_E8, ORACLE_DECIMALS]);

  // Vault
  const vaultImpl = await v.deployContract("CollateralVault", []);
  const vaultProxy = await v.deployContract("ERC1967Proxy", [
    vaultImpl.address as `0x${string}`,
    encodeFunctionData({ abi: vaultImpl.abi, functionName: "initialize", args: [usdc.address] }),
  ]);
  const vault = await v.getContractAt("CollateralVault", vaultProxy.address);

  const engineImpl = await v.deployContract("OptionMarginEngine", []);
  const engineProxy = await v.deployContract("ERC1967Proxy", [
    engineImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: engineImpl.abi,
      functionName: "initialize",
      args: [registry.address, usdc.address, oracle.address, vault.address],
    }),
  ]);
  const engine = await v.getContractAt("OptionMarginEngine", engineProxy.address);

  // PME with a perps mock (no perps linked to engine, but PME is mandatory)
  const perpsMock = await v.deployContract("PerpsDEXMock", []);
  await perpsMock.write.setMarketPrice([50_000_000_000n]);

  const pmeImpl = await v.deployContract("PortfolioMarginEngine", []);
  const pmeProxy = await v.deployContract("ERC1967Proxy", [
    pmeImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: pmeImpl.abi,
      functionName: "initialize",
      args: [vault.address, perpsMock.address, engine.address],
    }),
  ]);
  const pme = await v.getContractAt("PortfolioMarginEngine", pmeProxy.address);

  await vault.write.setMarginEngine([pme.address]);
  await vault.write.setAuthorizedCaller([engine.address, true]);
  await engine.write.setPortfolioMargin([pme.address], { account: owner.account });

  return { engine, traders: { trader1 } };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("Level 1 Perps Integration", () => {
  describe("admin", () => {
    it("setPerpsDex links the perps DEX", async () => {
      const { engine, perpsMock } = await networkHelpers.loadFixture(deployPerpsIntegrationFixture);

      const linked = await engine.read.perpsDex();
      assert.equal(linked.toLowerCase(), perpsMock.address.toLowerCase());
    });
  });

  describe("getPerpPosition", () => {
    it("returns zero when no perps position", async () => {
      const { engine, traders } = await networkHelpers.loadFixture(deployPerpsIntegrationFixture);

      const [qty, entry] = await engine.read.getPerpPosition([traders.trader1.account.address]);
      assert.equal(qty, 0n);
      assert.equal(entry, 0n);
    });

    it("reads perps position from mock DEX", async () => {
      const { engine, perpsMock, traders } = await networkHelpers.loadFixture(
        deployPerpsIntegrationFixture,
      );

      await perpsMock.write.setUserPosition([
        traders.trader1.account.address,
        2_000_000n,
        50000_000_000n,
      ]);

      const [qty, entry] = await engine.read.getPerpPosition([traders.trader1.account.address]);
      assert.equal(qty, 2_000_000n);
      assert.equal(entry, 50000_000_000n);
    });
  });

  describe("getPerpCollateral", () => {
    it("returns zero when no perps collateral", async () => {
      const { engine, traders } = await networkHelpers.loadFixture(deployPerpsIntegrationFixture);
      const col = await engine.read.getPerpCollateral([traders.trader1.account.address]);
      assert.equal(col, 0n);
    });

    it("returns 0 in Level 2 (collateral is in shared vault)", async () => {
      const { engine, traders } = await networkHelpers.loadFixture(deployPerpsIntegrationFixture);
      const col = await engine.read.getPerpCollateral([traders.trader1.account.address]);
      assert.equal(col, 0n);
    });
  });

  describe("getPortfolioOverview", () => {
    it("returns options-only data when no perps exposure", async () => {
      const { engine, traders } = await networkHelpers.loadFixture(deployPerpsIntegrationFixture);

      const p = await engine.read.getPortfolioOverview([traders.trader1.account.address]);

      const expectedWad = 50_000_000_000n * 10n ** 12n;
      assert.equal(p.optionsCollateral, expectedWad);
      assert.equal(p.optionsIM, 0n, "no options positions → IM = 0");
      assert.equal(p.optionsMM, 0n);
      assert.equal(p.optionsReserved, 0n);
      assert.equal(p.activeSeriesCount, 0n);

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

      await router.write.submitOrder(
        [
          {
            seriesId,
            isBuy: false,
            priceTicks: 100n,
            size: LOT,
            orderType: LIMIT,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: traders.trader2.account },
      );
      await router.write.submitOrder(
        [
          {
            seriesId,
            isBuy: true,
            priceTicks: 100n,
            size: LOT,
            orderType: LIMIT,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: traders.trader1.account },
      );

      await perpsMock.write.setUserPosition([
        traders.trader1.account.address,
        -1_000_000n,
        52000_000_000n,
      ]);
      await perpsMock.write.setBalance([traders.trader1.account.address, 20_000_000_000n]);
      await perpsMock.write.setUnrealizedPnl([traders.trader1.account.address, 1_500_000_000n]);
      await perpsMock.write.setMargins([
        traders.trader1.account.address,
        5_000_000_000n,
        3_000_000_000n,
      ]);

      const p = await engine.read.getPortfolioOverview([traders.trader1.account.address]);

      assert.equal(p.optionsIM, 0n, "long option position has no ongoing margin");
      assert.equal(p.activeSeriesCount, 1n);

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

      await perpsMock.write.setUserPosition([
        traders.trader1.account.address,
        -5_000_000n,
        50000_000_000n,
      ]);
      await perpsMock.write.setMargins([
        traders.trader1.account.address,
        10_000_000_000n,
        8_000_000_000n,
      ]);

      const p = await engine.read.getPortfolioOverview([traders.trader1.account.address]);
      assert.equal(p.perpIsLiquidatable, true, "perps should be flagged as liquidatable");
    });
  });

  describe("margin isolation", () => {
    it("options margin does not affect perps collateral", async () => {
      const { engine, router, traders, seriesId } = await networkHelpers.loadFixture(
        deployPerpsIntegrationFixture,
      );

      await router.write.submitOrder(
        [
          {
            seriesId,
            isBuy: false,
            priceTicks: 100n,
            size: LOT,
            orderType: LIMIT,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: traders.trader2.account },
      );
      await router.write.submitOrder(
        [
          {
            seriesId,
            isBuy: true,
            priceTicks: 100n,
            size: LOT,
            orderType: LIMIT,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: traders.trader1.account },
      );

      const perpCol = await engine.read.getPerpCollateral([traders.trader1.account.address]);
      assert.equal(perpCol, 0n, "getPerpCollateral returns 0 in Level 2");

      const optCol = await engine.read.getCollateral([traders.trader1.account.address]);
      const expectedOptCol = 50_000_000_000n * 10n ** 12n;
      assert.ok(optCol < expectedOptCol, "options collateral should decrease from premium paid");
    });

    it("perps position does not affect options margin calculation", async () => {
      const { engine, router, perpsMock, traders, seriesId } = await networkHelpers.loadFixture(
        deployPerpsIntegrationFixture,
      );

      await router.write.submitOrder(
        [
          {
            seriesId,
            isBuy: true,
            priceTicks: 100n,
            size: LOT,
            orderType: LIMIT,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: traders.trader2.account },
      );
      await router.write.submitOrder(
        [
          {
            seriesId,
            isBuy: false,
            priceTicks: 100n,
            size: LOT,
            orderType: LIMIT,
            postOnly: false,
            reduceOnly: false,
          },
        ],
        { account: traders.trader1.account },
      );

      const imBefore = await engine.read.computeAccountIM([traders.trader1.account.address]);

      await perpsMock.write.setUserPosition([
        traders.trader1.account.address,
        100_000_000n,
        50000_000_000n,
      ]);

      const imAfter = await engine.read.computeAccountIM([traders.trader1.account.address]);
      const drift = imAfter > imBefore ? imAfter - imBefore : imBefore - imAfter;
      const tolerance = imBefore / 10000n;
      assert.ok(drift <= tolerance, `options IM drift ${drift} exceeds tolerance ${tolerance}`);
    });
  });

  describe("no perps linked", () => {
    it("returns zeros when perpsDex is not set", async () => {
      const { engine, traders } = await networkHelpers.loadFixture(deployNoPerpsFixture);

      const [qty, entry] = await engine.read.getPerpPosition([traders.trader1.account.address]);
      assert.equal(qty, 0n);
      assert.equal(entry, 0n);

      const col = await engine.read.getPerpCollateral([traders.trader1.account.address]);
      assert.equal(col, 0n);

      const p = await engine.read.getPortfolioOverview([traders.trader1.account.address]);
      assert.equal(p.perpNetQuantity, 0n);
      assert.equal(p.perpIsLiquidatable, false);
    });
  });
});
