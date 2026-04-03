import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import type { NetworkConnection } from "hardhat/types/network";

const { viem, networkHelpers } = await network.connect();

async function deployHarness(conn: NetworkConnection) {
  const harness = await conn.viem.deployContract(
    "contracts/test/FixedPointMathHarness.sol:FixedPointMathHarness",
    [],
  );
  return { harness };
}

const WAD = 10n ** 18n;

function absBI(x: bigint): bigint {
  return x < 0n ? -x : x;
}

function assertApproxEq(actual: bigint, expected: bigint, toleranceBps: bigint, label: string) {
  const diff = absBI(actual - expected);
  const threshold = (absBI(expected) * toleranceBps) / 10000n;
  assert.ok(
    diff <= (threshold > 0n ? threshold : 1n),
    `${label}: expected ~${expected}, got ${actual} (diff ${diff}, threshold ${threshold})`,
  );
}

describe("FixedPointMathLib", () => {
  // ── exp ──────────────────────────────────────────────────────────────────

  describe("exp", () => {
    it("exp(0) = 1e18", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const result = await harness.read.exp([0n]);
      assertApproxEq(result, WAD, 1n, "exp(0)");
    });

    it("exp(1e18) ≈ e = 2.718281828e18", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const result = await harness.read.exp([WAD]);
      assertApproxEq(result, 2_718_281_828_459_045_235n, 1n, "exp(1)");
    });

    it("exp(-1e18) ≈ 1/e = 0.367879441e18", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const result = await harness.read.exp([-WAD]);
      assertApproxEq(result, 367_879_441_171_442_322n, 1n, "exp(-1)");
    });

    it("exp(2e18) ≈ e² = 7.389056099e18", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const result = await harness.read.exp([2n * WAD]);
      assertApproxEq(result, 7_389_056_098_930_650_227n, 1n, "exp(2)");
    });

    it("exp(very negative) = 0", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const result = await harness.read.exp([-50n * WAD]);
      assert.equal(result, 0n);
    });
  });

  // ── ln ──────────────────────────────────────────────────────────────────

  describe("ln", () => {
    it("ln(1e18) = 0 (ln(1) = 0)", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const result = await harness.read.ln([WAD]);
      assert.equal(result, 0n);
    });

    it("ln(e * 1e18) ≈ 1e18", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const e18 = 2_718_281_828_459_045_235n;
      const result = await harness.read.ln([e18]);
      assertApproxEq(result, WAD, 1n, "ln(e)");
    });

    it("ln(2e18) ≈ 0.693147e18", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const result = await harness.read.ln([2n * WAD]);
      assertApproxEq(result, 693_147_180_559_945_309n, 1n, "ln(2)");
    });

    it("ln(0.5e18) ≈ -0.693147e18", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const result = await harness.read.ln([WAD / 2n]);
      assertApproxEq(result, -693_147_180_559_945_309n, 1n, "ln(0.5)");
    });

    it("exp(ln(x)) round-trips", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const x = 42n * WAD;
      const lnX = await harness.read.ln([x]);
      const expLnX = await harness.read.exp([lnX]);
      assertApproxEq(expLnX, x, 5n, "exp(ln(42))");
    });
  });

  // ── sqrt ─────────────────────────────────────────────────────────────────

  describe("sqrt", () => {
    it("sqrt(0) = 0", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const result = await harness.read.sqrt([0n]);
      assert.equal(result, 0n);
    });

    it("sqrt(1e18) = 1e18", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const result = await harness.read.sqrt([WAD]);
      assertApproxEq(result, WAD, 1n, "sqrt(1)");
    });

    it("sqrt(4e18) = 2e18", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const result = await harness.read.sqrt([4n * WAD]);
      assertApproxEq(result, 2n * WAD, 1n, "sqrt(4)");
    });

    it("sqrt(2e18) ≈ 1.41421356e18", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const result = await harness.read.sqrt([2n * WAD]);
      assertApproxEq(result, 1_414_213_562_373_095_048n, 1n, "sqrt(2)");
    });
  });

  // ── abs ──────────────────────────────────────────────────────────────────

  describe("abs", () => {
    it("abs(positive) = same", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      assert.equal(await harness.read.abs([42n * WAD]), 42n * WAD);
    });

    it("abs(negative) = positive", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      assert.equal(await harness.read.abs([-42n * WAD]), 42n * WAD);
    });

    it("abs(0) = 0", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      assert.equal(await harness.read.abs([0n]), 0n);
    });
  });

  // ── stdNormalCDF ─────────────────────────────────────────────────────────

  describe("stdNormalCDF", () => {
    it("N(0) = 0.5", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const result = await harness.read.stdNormalCDF([0n]);
      assertApproxEq(result, WAD / 2n, 1n, "N(0)");
    });

    it("N(1) ≈ 0.8413", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const result = await harness.read.stdNormalCDF([WAD]);
      assertApproxEq(result, 841_344_746_068_543_000n, 5n, "N(1)");
    });

    it("N(-1) ≈ 0.1587", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const result = await harness.read.stdNormalCDF([-WAD]);
      assertApproxEq(result, 158_655_253_931_457_000n, 5n, "N(-1)");
    });

    it("N(x) + N(-x) = 1 (symmetry)", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const nPos = await harness.read.stdNormalCDF([2n * WAD]);
      const nNeg = await harness.read.stdNormalCDF([-2n * WAD]);
      assertApproxEq(nPos + nNeg, WAD, 1n, "symmetry at x=2");
    });

    it("N(2) ≈ 0.9772", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const result = await harness.read.stdNormalCDF([2n * WAD]);
      assertApproxEq(result, 977_249_868_051_821_000n, 5n, "N(2)");
    });

    it("N(-3) ≈ 0.00135", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const result = await harness.read.stdNormalCDF([-3n * WAD]);
      assertApproxEq(result, 1_349_898_031_630_000n, 10n, "N(-3)");
    });

    it("N(large) → 1", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const result = await harness.read.stdNormalCDF([10n * WAD]);
      assertApproxEq(result, WAD, 1n, "N(10)");
    });

    it("N(very negative) → 0", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const result = await harness.read.stdNormalCDF([-10n * WAD]);
      assert.ok(result < WAD / 1_000_000n, `N(-10) should be near zero, got ${result}`);
    });
  });

  // ── stdNormal (PDF) ──────────────────────────────────────────────────────

  describe("stdNormal (PDF)", () => {
    it("φ(0) ≈ 0.39894 (peak of bell curve)", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const result = await harness.read.stdNormal([0n]);
      assertApproxEq(result, 398_942_280_401_432_678n, 5n, "φ(0)");
    });

    it("φ(1) ≈ 0.24197", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const result = await harness.read.stdNormal([WAD]);
      assertApproxEq(result, 241_970_724_519_143_365n, 5n, "φ(1)");
    });

    it("φ(x) = φ(-x) (symmetric)", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const pos = await harness.read.stdNormal([WAD]);
      const neg = await harness.read.stdNormal([-WAD]);
      assertApproxEq(pos, neg, 1n, "symmetry φ(1) vs φ(-1)");
    });
  });

  // ── decPow ────────────────────────────────────────────────────────────────

  describe("decPow", () => {
    it("2^10 = 1024", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const result = await harness.read.decPow([2n * WAD, 10n * WAD]);
      assertApproxEq(result, 1024n * WAD, 5n, "2^10");
    });

    it("3^3 = 27", async () => {
      const { harness } = await networkHelpers.loadFixture(deployHarness);
      const result = await harness.read.decPow([3n * WAD, 3n * WAD]);
      assertApproxEq(result, 27n * WAD, 5n, "3^3");
    });
  });
});
