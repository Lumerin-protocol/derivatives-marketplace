import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import type { NetworkConnection } from "hardhat/types/network";

const { viem, networkHelpers } = await network.connect();

async function deployHarness(conn: NetworkConnection) {
  const harness = await conn.viem.deployContract("Black76Harness", []);
  return { harness };
}

const WAD = 10n ** 18n;
const YEAR = 365n * 24n * 60n * 60n;

function absBI(x: bigint): bigint {
  return x < 0n ? -x : x;
}

function assertApproxEq(actual: bigint, expected: bigint, toleranceBps: bigint, label: string) {
  const diff = absBI(actual - expected);
  const threshold = (absBI(expected) * toleranceBps) / 10000n;
  assert.ok(
    diff <= (threshold > 0n ? threshold : WAD / 10000n),
    `${label}: expected ~${expected}, got ${actual} (diff ${diff}, threshold ${threshold})`,
  );
}

describe("Black76Lib", () => {
  // ── ATM pricing ──────────────────────────────────────────────────────────

  describe("ATM pricing (F = K = 100, σ = 20%, T = 1y)", () => {
    const F = 100n * WAD;
    const K = 100n * WAD;
    const sigma = (20n * WAD) / 100n;
    const tSec = YEAR;

    it("call ≈ put (ATM put-call parity with D=1, F=K)", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const callP = await harness.read.callPrice([F, K, sigma, tSec]);
      const putP = await harness.read.putPrice([F, K, sigma, tSec]);
      assertApproxEq(callP, putP, 1n, "ATM call ≈ put");
    });

    it("call ≈ 7.97 (Black-76 ATM)", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const callP = await harness.read.callPrice([F, K, sigma, tSec]);
      assertApproxEq(callP, 7_965_567_455_405_796_000n, 50n, "ATM call");
    });

    it("call delta ≈ 0.54 (slightly above 0.5 for ATM)", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const [, , cDelta] = await harness.read.pricesAndDelta([F, K, sigma, tSec]);
      assert.ok(cDelta > WAD / 2n, "ATM call delta > 0.5");
      assert.ok(cDelta < (60n * WAD) / 100n, "ATM call delta < 0.6");
    });
  });

  // ── ITM / OTM pricing ──────────────────────────────────────────────────

  describe("ITM/OTM pricing", () => {
    const sigma = (30n * WAD) / 100n;
    const tSec = YEAR / 2n;

    it("deep ITM call (F=100, K=50) ≈ 50 (intrinsic)", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const callP = await harness.read.callPrice([100n * WAD, 50n * WAD, sigma, tSec]);
      assert.ok(callP >= 50n * WAD, "deep ITM call >= intrinsic");
      assert.ok(callP < 55n * WAD, "deep ITM call < intrinsic + time value");
    });

    it("deep OTM call (F=100, K=200) ≈ 0", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const callP = await harness.read.callPrice([100n * WAD, 200n * WAD, sigma, tSec]);
      assert.ok(callP < WAD, "deep OTM call near zero");
    });

    it("deep ITM put (F=100, K=200) ≈ 100 (intrinsic)", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const putP = await harness.read.putPrice([100n * WAD, 200n * WAD, sigma, tSec]);
      assert.ok(putP >= 100n * WAD, "deep ITM put >= intrinsic");
    });
  });

  // ── Put-call parity ──────────────────────────────────────────────────────

  describe("put-call parity: call - put = F - K (with D=1)", () => {
    it("holds for OTM call (F=100, K=110)", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const F = 100n * WAD;
      const K = 110n * WAD;
      const sigma = (25n * WAD) / 100n;
      const callP = await harness.read.callPrice([F, K, sigma, YEAR]);
      const putP = await harness.read.putPrice([F, K, sigma, YEAR]);
      const lhs = callP - putP;
      const rhs = F - K;
      assertApproxEq(lhs, rhs, 5n, "put-call parity OTM call");
    });

    it("holds for ITM call (F=100, K=90)", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const F = 100n * WAD;
      const K = 90n * WAD;
      const sigma = (25n * WAD) / 100n;
      const callP = await harness.read.callPrice([F, K, sigma, YEAR]);
      const putP = await harness.read.putPrice([F, K, sigma, YEAR]);
      const lhs = callP - putP;
      const rhs = F - K;
      assertApproxEq(lhs, rhs, 5n, "put-call parity ITM call");
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("K=0 → call=F, put=0", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const [c, p, d] = await harness.read.pricesAndDelta([100n * WAD, 0n, WAD / 5n, YEAR]);
      assert.equal(c, 100n * WAD);
      assert.equal(p, 0n);
      assert.equal(d, WAD);
    });

    it("F=0 → call=0, put=K", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const [c, p, d] = await harness.read.pricesAndDelta([0n, 100n * WAD, WAD / 5n, YEAR]);
      assert.equal(c, 0n);
      assert.equal(p, 100n * WAD);
      assert.equal(d, 0n);
    });

    it("very short expiry (1 second) → near intrinsic", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const callP = await harness.read.callPrice([100n * WAD, 90n * WAD, WAD / 5n, 1n]);
      assertApproxEq(callP, 10n * WAD, 100n, "near-expiry ITM call ≈ intrinsic");
    });
  });

  // ── Greeks ────────────────────────────────────────────────────────────────

  describe("Greeks", () => {
    const F = 100n * WAD;
    const K = 100n * WAD;
    const sigma = (20n * WAD) / 100n;
    const tSec = YEAR;

    it("ATM call delta ≈ 0.54, put delta ≈ -0.46", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const [callDelta] = await harness.read.greeks([F, K, sigma, tSec, true]);
      const [putDelta] = await harness.read.greeks([F, K, sigma, tSec, false]);
      assert.ok(callDelta > 0n, "call delta positive");
      assert.ok(putDelta < 0n, "put delta negative");
      // Black-76: call_delta - put_delta = 1
      assertApproxEq(callDelta - putDelta, WAD, 1n, "call delta - put delta = 1");
    });

    it("gamma is positive and equal for call/put", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const [, callGamma] = await harness.read.greeks([F, K, sigma, tSec, true]);
      const [, putGamma] = await harness.read.greeks([F, K, sigma, tSec, false]);
      assert.ok(callGamma > 0n, "gamma > 0");
      assertApproxEq(callGamma, putGamma, 1n, "call gamma = put gamma");
    });

    it("vega is positive and equal for call/put", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const [, , callVega] = await harness.read.greeks([F, K, sigma, tSec, true]);
      const [, , putVega] = await harness.read.greeks([F, K, sigma, tSec, false]);
      assert.ok(callVega > 0n, "vega > 0");
      assertApproxEq(callVega, putVega, 1n, "call vega = put vega");
    });

    it("deep OTM gamma → 0", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const [, gamma] = await harness.read.greeks([100n * WAD, 200n * WAD, sigma, tSec, true]);
      assert.ok(gamma < WAD / 1000n, "deep OTM gamma near zero");
    });
  });

  // ── IV solver ────────────────────────────────────────────────────────────

  describe("implied vol solver", () => {
    it("round-trips: price at σ=30%, recover σ from IV solver", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const F = 100n * WAD;
      const K = 100n * WAD;
      const sigma = (30n * WAD) / 100n;

      const premium = await harness.read.callPrice([F, K, sigma, YEAR]);
      const recoveredSigma = await harness.read.impliedVol([F, K, YEAR, premium, true]);
      assertApproxEq(recoveredSigma, sigma, 50n, "IV round-trip ATM");
    });

    it("round-trips for OTM put (F=100, K=80, σ=40%)", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const F = 100n * WAD;
      const K = 80n * WAD;
      const sigma = (40n * WAD) / 100n;

      const premium = await harness.read.putPrice([F, K, sigma, YEAR]);
      const recoveredSigma = await harness.read.impliedVol([F, K, YEAR, premium, false]);
      assertApproxEq(recoveredSigma, sigma, 100n, "IV round-trip OTM put");
    });

    it("reverts if premium < intrinsic", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      await assert.rejects(harness.read.impliedVol([100n * WAD, 90n * WAD, YEAR, 5n * WAD, true]));
    });
  });
});
