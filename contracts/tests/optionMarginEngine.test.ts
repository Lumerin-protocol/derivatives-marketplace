import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import {
  deployMarginEngineFixture,
  INITIAL_PRICE_E8,
  ORACLE_DECIMALS,
} from "./optionsFixtures.ts";

const { networkHelpers } = await network.connect();

const WAD = 10n ** 18n;
const USDC_DECIMALS = 6;

function toWad(usdcAmount: bigint): bigint {
  return usdcAmount * 10n ** 12n;
}

describe("OptionMarginEngine", () => {
  // ── Initialization ──────────────────────────────────────────────────────

  describe("initialization", () => {
    it("sets registry, collateralToken, oracle addresses", async () => {
      const { engine, registry, usdc, oracle } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);

      assert.equal(
        (await engine.read.registry()).toLowerCase(),
        registry.address.toLowerCase(),
      );
      assert.equal(
        (await engine.read.collateralToken()).toLowerCase(),
        usdc.address.toLowerCase(),
      );
      assert.equal(
        (await engine.read.oracle()).toLowerCase(),
        oracle.address.toLowerCase(),
      );
    });

    it("default margin params match expected values", async () => {
      const { engine } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);
      const cfg = await engine.read.marginConfig();
      assert.equal(cfg[0], 1500); // imSpotShockBps
      assert.equal(cfg[1], 1000); // mmSpotShockBps
      assert.equal(cfg[2], 100000000000000000n); // imVolShock 0.10e18
      assert.equal(cfg[3], 50000000000000000n); // mmVolShock 0.05e18
    });

    it("maxSeriesPerUser defaults to 20", async () => {
      const { engine } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);
      assert.equal(await engine.read.maxSeriesPerUser(), 20);
    });

    it("tokenDecimals = 6 for USDC", async () => {
      const { engine } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);
      assert.equal(await engine.read.tokenDecimals(), USDC_DECIMALS);
    });

    it("oracleDecimals matches mock", async () => {
      const { engine } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);
      assert.equal(await engine.read.oracleDecimals(), ORACLE_DECIMALS);
    });
  });

  // ── Deposit / Withdraw ────────────────────────────────────────────────

  describe("deposit / withdraw", () => {
    it("deposit increases collateral (WAD-scaled)", async () => {
      const { engine, traders } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);

      const amount = 10_000_000n; // 10 USDC
      await engine.write.deposit([amount], {
        account: traders.trader1.account,
      });

      const bal = await engine.read.getCollateral([
        traders.trader1.account.address,
      ]);
      assert.equal(bal, toWad(amount));
    });

    it("withdraw decreases collateral", async () => {
      const { engine, traders } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);

      const dep = 10_000_000n;
      const wd = 3_000_000n;
      await engine.write.deposit([dep], {
        account: traders.trader1.account,
      });
      await engine.write.withdraw([wd], {
        account: traders.trader1.account,
      });

      const bal = await engine.read.getCollateral([
        traders.trader1.account.address,
      ]);
      assert.equal(bal, toWad(dep - wd));
    });

    it("withdraw reverts if insufficient collateral", async () => {
      const { engine, traders } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);

      await engine.write.deposit([1_000_000n], {
        account: traders.trader1.account,
      });
      await assert.rejects(
        engine.write.withdraw([2_000_000n], {
          account: traders.trader1.account,
        }),
      );
    });

    it("deposit reverts on zero amount", async () => {
      const { engine, traders } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);

      await assert.rejects(
        engine.write.deposit([0n], { account: traders.trader1.account }),
      );
    });
  });

  // ── Position updates ──────────────────────────────────────────────────

  describe("updatePosition", () => {
    it("increases long position", async () => {
      const { engine, traders, seriesId, accounts } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);

      await engine.write.updatePosition(
        [traders.trader1.account.address, seriesId, 5n],
        { account: accounts.owner.account },
      );
      const qty = await engine.read.getPosition([
        traders.trader1.account.address,
        seriesId,
      ]);
      assert.equal(qty, 5n);
    });

    it("adds and removes from active series set", async () => {
      const { engine, traders, seriesId, accounts } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);

      await engine.write.updatePosition(
        [traders.trader1.account.address, seriesId, 3n],
        { account: accounts.owner.account },
      );
      assert.equal(
        await engine.read.getUserActiveSeriesCount([
          traders.trader1.account.address,
        ]),
        1n,
      );

      // Close position
      await engine.write.updatePosition(
        [traders.trader1.account.address, seriesId, -3n],
        { account: accounts.owner.account },
      );
      assert.equal(
        await engine.read.getUserActiveSeriesCount([
          traders.trader1.account.address,
        ]),
        0n,
      );
    });

    it("reverts if not called by router", async () => {
      const { engine, traders, seriesId } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);

      await assert.rejects(
        engine.write.updatePosition(
          [traders.trader1.account.address, seriesId, 1n],
          { account: traders.trader2.account },
        ),
      );
    });
  });

  // ── IV management ─────────────────────────────────────────────────────

  describe("IV management", () => {
    it("initializeIV sets IV from registry initialIV", async () => {
      const { engine, seriesId } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);

      await engine.write.initializeIV([seriesId]);
      const [ewmaIV] = await engine.read.getIVState([seriesId]);
      assert.equal(ewmaIV, 500_000_000_000_000_000n); // 0.5e18
    });

    it("initializeIV is idempotent", async () => {
      const { engine, seriesId } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);

      await engine.write.initializeIV([seriesId]);
      await engine.write.initializeIV([seriesId]); // no-op
      const [ewmaIV] = await engine.read.getIVState([seriesId]);
      assert.equal(ewmaIV, 500_000_000_000_000_000n);
    });

    it("updateIV applies EWMA smoothing", async () => {
      const { engine, seriesId, accounts } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);

      await engine.write.initializeIV([seriesId]);
      const [ivBefore] = await engine.read.getIVState([seriesId]);

      // Trade at a premium that implies a different IV. Use ATM call premium
      // with F = K = 50000. The premium is roughly F * sigma * sqrt(T) * 0.4
      // For sigma=0.6 (higher than 0.5 initial): premium ≈ 50000 * 0.6 * 1 * 0.4 ≈ 12000
      // In WAD: 12000e18
      const tradePremium = 12000n * WAD;
      await engine.write.updateIV([seriesId, tradePremium, true], {
        account: accounts.owner.account,
      });

      const [ivAfter] = await engine.read.getIVState([seriesId]);
      // IV should have moved (either up or down from initial)
      assert.notEqual(ivAfter, ivBefore);
    });

    it("updateIV clamps per-update change to maxIVChangeBps", async () => {
      const { engine, seriesId, accounts } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);

      await engine.write.initializeIV([seriesId]);
      const [ivBefore] = await engine.read.getIVState([seriesId]);

      // Trade at a very extreme premium to force a large IV change
      const extremePremium = 40000n * WAD; // huge premium → very high IV
      await engine.write.updateIV([seriesId, extremePremium, true], {
        account: accounts.owner.account,
      });

      const [ivAfter] = await engine.read.getIVState([seriesId]);
      const maxChange = (ivBefore * 500n) / 10000n; // 5%
      const actualChange =
        ivAfter > ivBefore ? ivAfter - ivBefore : ivBefore - ivAfter;
      assert.ok(actualChange <= maxChange + 1n, "IV change should be clamped");
    });

    it("updateIV reverts if IV not initialized", async () => {
      const { engine, seriesId, accounts } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);

      await assert.rejects(
        engine.write.updateIV([seriesId, 1000n * WAD, true], {
          account: accounts.owner.account,
        }),
      );
    });
  });

  // ── Margin computation ────────────────────────────────────────────────

  describe("margin computation", () => {
    it("long position requires zero ongoing margin", async () => {
      const { engine, traders, seriesId, accounts } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);

      await engine.write.initializeIV([seriesId]);
      await engine.write.updatePosition(
        [traders.trader1.account.address, seriesId, 10n],
        { account: accounts.owner.account },
      );

      const im = await engine.read.computeAccountIM([
        traders.trader1.account.address,
      ]);
      assert.equal(im, 0n, "longs need no ongoing margin");
    });

    it("short position requires positive IM and MM", async () => {
      const { engine, traders, seriesId, accounts } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);

      await engine.write.initializeIV([seriesId]);

      // Go short
      await engine.write.updatePosition(
        [traders.trader1.account.address, seriesId, -5n],
        { account: accounts.owner.account },
      );

      const im = await engine.read.computeAccountIM([
        traders.trader1.account.address,
      ]);
      const mm = await engine.read.computeAccountMM([
        traders.trader1.account.address,
      ]);

      assert.ok(im > 0n, "short IM > 0");
      assert.ok(mm > 0n, "short MM > 0");
      assert.ok(im > mm, "IM > MM (IM uses larger shocks)");
    });

    it("IM scales with position size", async () => {
      const { engine, traders, seriesId, accounts } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);

      await engine.write.initializeIV([seriesId]);

      await engine.write.updatePosition(
        [traders.trader1.account.address, seriesId, -1n],
        { account: accounts.owner.account },
      );
      const im1 = await engine.read.computeAccountIM([
        traders.trader1.account.address,
      ]);

      await engine.write.updatePosition(
        [traders.trader2.account.address, seriesId, -10n],
        { account: accounts.owner.account },
      );
      const im10 = await engine.read.computeAccountIM([
        traders.trader2.account.address,
      ]);

      // im10 should be approximately 10x im1
      const ratio = (im10 * 100n) / im1;
      assert.ok(
        ratio >= 990n && ratio <= 1010n,
        `expected ~1000, got ${ratio}`,
      );
    });

    it("computeOrderIM returns positive value for sell order", async () => {
      const { engine, seriesId } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);

      await engine.write.initializeIV([seriesId]);

      const orderIM = await engine.read.computeOrderIM([seriesId, 1n]);
      assert.ok(orderIM > 0n, "order IM > 0 for a sell order");
    });
  });

  // ── Health checks ─────────────────────────────────────────────────────

  describe("health checks", () => {
    it("healthy with enough collateral", async () => {
      const { engine, traders, seriesId, accounts } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);

      await engine.write.initializeIV([seriesId]);

      await engine.write.deposit([50_000_000_000n], {
        account: traders.trader1.account,
      }); // 50k USDC
      await engine.write.updatePosition(
        [traders.trader1.account.address, seriesId, -1n],
        { account: accounts.owner.account },
      );

      const healthy = await engine.read.isHealthy([
        traders.trader1.account.address,
      ]);
      assert.ok(healthy, "should be healthy with ample collateral");
    });

    it("unhealthy with insufficient collateral", async () => {
      const { engine, traders, seriesId, accounts } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);

      await engine.write.initializeIV([seriesId]);

      // Deposit a tiny amount
      await engine.write.deposit([1_000n], {
        account: traders.trader1.account,
      }); // $0.001
      await engine.write.updatePosition(
        [traders.trader1.account.address, seriesId, -100n],
        { account: accounts.owner.account },
      );

      const healthy = await engine.read.isHealthy([
        traders.trader1.account.address,
      ]);
      assert.ok(!healthy, "should be unhealthy with tiny collateral");
    });

    it("canPlaceOrder respects reserved + IM + additional", async () => {
      const { engine, traders, seriesId, accounts } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);

      await engine.write.initializeIV([seriesId]);

      const orderIM = await engine.read.computeOrderIM([seriesId, 1n]);
      // Deposit just enough for one order's IM
      const wadUnit = 10n ** 12n;
      const usdcNeeded = orderIM / wadUnit + 1n;
      await engine.write.deposit([usdcNeeded], {
        account: traders.trader1.account,
      });

      // Should be able to place one order
      const can1 = await engine.read.canPlaceOrder([
        traders.trader1.account.address,
        orderIM,
      ]);
      assert.ok(can1, "should be able to place with enough collateral");

      // Should NOT be able to place a much larger order
      const can2 = await engine.read.canPlaceOrder([
        traders.trader1.account.address,
        orderIM * 1000n,
      ]);
      assert.ok(!can2, "should not be able to place a huge order");
    });
  });

  // ── Reserved margin ───────────────────────────────────────────────────

  describe("reserved margin", () => {
    it("reserveMargin increases reserved balance", async () => {
      const { engine, traders, accounts } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);

      const amount = 5000n * WAD;
      await engine.write.reserveMargin(
        [traders.trader1.account.address, amount],
        { account: accounts.owner.account },
      );

      const reserved = await engine.read.getReservedMargin([
        traders.trader1.account.address,
      ]);
      assert.equal(reserved, amount);
    });

    it("releaseMargin decreases reserved balance", async () => {
      const { engine, traders, accounts } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);

      const amount = 5000n * WAD;
      await engine.write.reserveMargin(
        [traders.trader1.account.address, amount],
        { account: accounts.owner.account },
      );
      await engine.write.releaseMargin(
        [traders.trader1.account.address, 2000n * WAD],
        { account: accounts.owner.account },
      );

      const reserved = await engine.read.getReservedMargin([
        traders.trader1.account.address,
      ]);
      assert.equal(reserved, 3000n * WAD);
    });

    it("releaseMargin saturates at zero (no underflow)", async () => {
      const { engine, traders, accounts } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);

      await engine.write.reserveMargin(
        [traders.trader1.account.address, 100n * WAD],
        { account: accounts.owner.account },
      );
      await engine.write.releaseMargin(
        [traders.trader1.account.address, 999n * WAD],
        { account: accounts.owner.account },
      );

      const reserved = await engine.read.getReservedMargin([
        traders.trader1.account.address,
      ]);
      assert.equal(reserved, 0n);
    });

    it("withdrawal fails when reserved margin occupies collateral", async () => {
      const { engine, traders, accounts } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);

      // Deposit 10 USDC = 10e6
      await engine.write.deposit([10_000_000n], {
        account: traders.trader1.account,
      });

      // Reserve 9.99 USDC worth of margin (in WAD)
      const reserveWad = 9_990_000n * 10n ** 12n;
      await engine.write.reserveMargin(
        [traders.trader1.account.address, reserveWad],
        { account: accounts.owner.account },
      );

      // Trying to withdraw 1 USDC should fail because collateral - withdraw < reserved
      await assert.rejects(
        engine.write.withdraw([1_000_000n], {
          account: traders.trader1.account,
        }),
      );
    });
  });

  // ── Oracle integration ────────────────────────────────────────────────

  describe("oracle integration", () => {
    it("getForwardPrice returns WAD-scaled oracle price", async () => {
      const { engine } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);

      const fwd = await engine.read.getForwardPrice();
      // INITIAL_PRICE_E8 = 50000_00000000 (8 decimals) → WAD = 50000e18
      const expectedWad = INITIAL_PRICE_E8 * 10n ** 10n;
      assert.equal(fwd, expectedWad);
    });

    it("stale oracle reverts", async () => {
      const { engine, oracle, accounts } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);

      // Freeze oracle timestamp, then advance time past staleness
      await oracle.write.freezeTimestamp([], {
        account: accounts.owner.account,
      });
      await networkHelpers.time.increase(3601); // > 1 hour

      await assert.rejects(engine.read.getForwardPrice());
    });
  });

  // ── Admin ─────────────────────────────────────────────────────────────

  describe("admin", () => {
    it("setMarginConfig updates params", async () => {
      const { engine, accounts } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);

      await engine.write.setMarginConfig(
        [2000, 1500, 200000000000000000n, 100000000000000000n],
        { account: accounts.owner.account },
      );

      const cfg = await engine.read.marginConfig();
      assert.equal(cfg[0], 2000);
      assert.equal(cfg[1], 1500);
    });

    it("non-owner cannot setMarginConfig", async () => {
      const { engine, traders } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);

      await assert.rejects(
        engine.write.setMarginConfig(
          [2000, 1500, 200000000000000000n, 100000000000000000n],
          { account: traders.trader1.account },
        ),
      );
    });

    it("setRouter updates router", async () => {
      const { engine, accounts, traders } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);

      await engine.write.setRouter([traders.trader1.account.address], {
        account: accounts.owner.account,
      });
      assert.equal(
        (await engine.read.router()).toLowerCase(),
        traders.trader1.account.address.toLowerCase(),
      );
    });
  });

  // ── MAX_SERIES_PER_USER cap ───────────────────────────────────────────

  describe("series cap", () => {
    it("reverts when exceeding maxSeriesPerUser", async () => {
      const { engine, registry, traders, accounts } =
        await networkHelpers.loadFixture(deployMarginEngineFixture);

      // Set max to 2 for this test
      await engine.write.setMaxSeriesPerUser([2], {
        account: accounts.owner.account,
      });

      const now = await networkHelpers.time.latest();
      const farExpiry = BigInt(now) + 365n * 86400n;

      // Create series 2 and 3
      await registry.write.createSeries(
        [60000_00000000n, farExpiry, true, 1_000_000n, 1_000_000, 500_000_000_000_000_000n],
        { account: accounts.owner.account },
      );
      await registry.write.createSeries(
        [70000_00000000n, farExpiry, false, 1_000_000n, 1_000_000, 500_000_000_000_000_000n],
        { account: accounts.owner.account },
      );

      const seriesId1 = 1n; // from fixture
      const seriesId2 = 2n;
      const seriesId3 = 3n;

      // Open positions in series 1 and 2
      await engine.write.updatePosition(
        [traders.trader1.account.address, seriesId1, 1n],
        { account: accounts.owner.account },
      );
      await engine.write.updatePosition(
        [traders.trader1.account.address, seriesId2, 1n],
        { account: accounts.owner.account },
      );

      // Third series should revert
      await assert.rejects(
        engine.write.updatePosition(
          [traders.trader1.account.address, seriesId3, 1n],
          { account: accounts.owner.account },
        ),
      );
    });
  });
});
