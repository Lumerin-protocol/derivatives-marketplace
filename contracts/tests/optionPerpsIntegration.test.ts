import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { encodeFunctionData, maxUint256 } from "viem";
import type { NetworkConnection } from "hardhat/types/network";
import { defaultSeries, INITIAL_PRICE_E8, ORACLE_DECIMALS } from "./optionsFixtures.ts";

const { networkHelpers, viem } = await network.getOrCreate();

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

  // ── PME (reads spot from its own oracle reference) ────────────────────
  const pmeImpl = await v.deployContract("PortfolioMarginEngine", []);
  const pmeProxy = await v.deployContract("ERC1967Proxy", [
    pmeImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: pmeImpl.abi,
      functionName: "initialize",
      args: [],
    }),
  ]);
  const pme = await v.getContractAt("PortfolioMarginEngine", pmeProxy.address);
  // The PME pins each product to its own vault at registration.
  await pme.write.setVault([vault.address]);
  await perpsMock.write.setVault([vault.address]);
  await pme.write.addLinearMarket([perpsMock.address]);
  await pme.write.setOptions([engine.address]);
  await pme.write.setOracle([oracle.address]);

  // ── Wiring ────────────────────────────────────────────────────────────
  await vault.write.setMarginEngine([pme.address]);
  await vault.write.setAuthorizedCaller([engine.address, true]);
  await engine.write.setPortfolioMargin([pme.address]);
  await engine.write.setPerpsDex([perpsMock.address]);

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

  await book.write.setRouter([router.address]);
  await engine.write.setRouter([router.address]);

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
  const trader1 = wallets[3];
  const trader2 = wallets[4];

  const depositAmount = 50_000_000_000n; // 50k USDC
  for (const w of [trader1, trader2]) {
    await usdc.write.transfer([w.account.address, depositAmount * 2n]);
    const usdcAs = await v.getContractAt("USDCMock", usdc.address, { client: { wallet: w } });
    await usdcAs.write.approve([vault.address, maxUint256]);
    await vault.write.deposit([depositAmount], { account: w.account });
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
  const [_owner] = await v.getWalletClients();
  const wallets = await v.getWalletClients();
  const trader1 = wallets[3];

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

  // PME with a perps mock (no perps linked to engine, but PME is mandatory);
  // PME reads spot from its own oracle reference.
  const perpsMock = await v.deployContract("PerpsDEXMock", []);

  const pmeImpl = await v.deployContract("PortfolioMarginEngine", []);
  const pmeProxy = await v.deployContract("ERC1967Proxy", [
    pmeImpl.address as `0x${string}`,
    encodeFunctionData({
      abi: pmeImpl.abi,
      functionName: "initialize",
      args: [],
    }),
  ]);
  const pme = await v.getContractAt("PortfolioMarginEngine", pmeProxy.address);
  await pme.write.setVault([vault.address]);
  await perpsMock.write.setVault([vault.address]);
  await pme.write.addLinearMarket([perpsMock.address]);
  await pme.write.setOptions([engine.address]);
  await pme.write.setOracle([oracle.address]);

  await vault.write.setMarginEngine([pme.address]);
  await vault.write.setAuthorizedCaller([engine.address, true]);
  await engine.write.setPortfolioMargin([pme.address]);

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
      assert.equal(p.perpOrderMargin, 0n);
      assert.equal(p.perpIsLiquidatable, false);
    });

    it("returns combined options + perps data", async () => {
      const { engine, pme, router, perpsMock, traders, seriesId } = await networkHelpers.loadFixture(
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
      // Resting asks on top of an existing short: the sell leg takes the account to
      // net short 2 lots, so the orders genuinely cost margin.
      await perpsMock.write.setOrderDeltas([traders.trader1.account.address, 0n, 1_000_000n]);
      await perpsMock.write.setMaintenanceMargin([traders.trader1.account.address, 3_000_000_000n]);

      const gas = await (await viem.getPublicClient()).estimateGas({
        account: traders.trader1.account,
        to: engine.address,
        data: encodeFunctionData({
          abi: engine.abi,
          functionName: "getPortfolioOverview",
          args: [traders.trader1.account.address],
        }),
      });
      console.log(`  getPortfolioOverview combined exposure: ${gas.toLocaleString()} gas`);
      const p = await engine.read.getPortfolioOverview([traders.trader1.account.address]);

      assert.equal(p.optionsIM, 0n, "long option position has no ongoing margin");
      assert.equal(p.activeSeriesCount, 1n);

      assert.equal(p.perpNetQuantity, -1_000_000n);
      assert.equal(p.perpUnrealizedPnl, 1_500_000_000n);
      // Order margin is now the engine's cross-product figure, not a perps-only scalar.
      assert.ok(p.perpOrderMargin > 0n);
      assert.equal(
        p.perpOrderMargin,
        await pme.read.orderMarginOf([traders.trader1.account.address]),
      );
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
      await perpsMock.write.setMaintenanceMargin([traders.trader1.account.address, 8_000_000_000n]);

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
