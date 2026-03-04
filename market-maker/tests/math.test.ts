import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  roundDownToTick,
  roundUpToTick,
  calculateNotional,
  applyBps,
  RollingWindow,
  RollingBudget,
  bigAbs,
  BPS_SCALE,
} from "../src/math.ts";

describe("roundDownToTick", () => {
  it("rounds exactly aligned prices unchanged", () => {
    assert.equal(roundDownToTick(100n, 10n), 100n);
  });

  it("rounds down unaligned price", () => {
    assert.equal(roundDownToTick(105n, 10n), 100n);
    assert.equal(roundDownToTick(99n, 10n), 90n);
  });

  it("handles single-unit tick", () => {
    assert.equal(roundDownToTick(12345n, 1n), 12345n);
  });
});

describe("roundUpToTick", () => {
  it("rounds exactly aligned prices unchanged", () => {
    assert.equal(roundUpToTick(100n, 10n), 100n);
  });

  it("rounds up unaligned price", () => {
    assert.equal(roundUpToTick(101n, 10n), 110n);
    assert.equal(roundUpToTick(91n, 10n), 100n);
  });
});

describe("calculateNotional", () => {
  it("computes price * absQuantity / 1e6", () => {
    // 100 USDC price * 1.0 quantity (1_000_000) = 100 USDC
    const result = calculateNotional(100_000_000n, 1_000_000n);
    assert.equal(result, 100_000_000n);
  });

  it("handles fractional quantities", () => {
    // 50 USDC * 0.5 units = 25 USDC
    const result = calculateNotional(50_000_000n, 500_000n);
    assert.equal(result, 25_000_000n);
  });
});

describe("applyBps", () => {
  it("adds positive bps", () => {
    // 10000 * (10000 + 100) / 10000 = 10100
    assert.equal(applyBps(10_000n, 100n), 10_100n);
  });

  it("subtracts negative bps", () => {
    // 10000 * (10000 - 100) / 10000 = 9900
    assert.equal(applyBps(10_000n, -100n), 9_900n);
  });
});

describe("RollingWindow", () => {
  it("computes volatility from price samples", () => {
    const w = new RollingWindow(10);
    // Constant prices → zero volatility
    for (let i = 0; i < 5; i++) w.push(100);
    assert.equal(w.volatility(), 0);
  });

  it("computes non-zero volatility for varying prices", () => {
    const w = new RollingWindow(10);
    w.push(100);
    w.push(102);
    w.push(98);
    w.push(101);
    w.push(99);
    assert.ok(w.volatility() > 0);
  });

  it("computes median", () => {
    const w = new RollingWindow(5);
    w.push(5);
    w.push(1);
    w.push(3);
    assert.equal(w.median(), 3);
  });

  it("computes median for even count", () => {
    const w = new RollingWindow(5);
    w.push(1);
    w.push(3);
    w.push(5);
    w.push(7);
    assert.equal(w.median(), 4);
  });

  it("respects max size", () => {
    const w = new RollingWindow(3);
    w.push(1);
    w.push(2);
    w.push(3);
    w.push(4);
    assert.equal(w.length, 3);
    assert.equal(w.latest(), 4);
  });

  it("returns 0 volatility for < 3 samples", () => {
    const w = new RollingWindow(10);
    w.push(100);
    w.push(200);
    assert.equal(w.volatility(), 0);
  });

  it("skips log-returns when samples are zero or negative", () => {
    const w = new RollingWindow(10);
    w.push(0);
    w.push(0);
    w.push(0);
    w.push(100);
    // First three log-returns are skipped (prev=0), only one valid return → < 2 → returns 0
    assert.equal(w.volatility(), 0);
  });

  it("returns 0 median for empty window", () => {
    const w = new RollingWindow(5);
    assert.equal(w.median(), 0);
  });

  it("returns undefined latest for empty window", () => {
    const w = new RollingWindow(5);
    assert.equal(w.latest(), undefined);
  });

  it("does not shift when under maxSize", () => {
    const w = new RollingWindow(10);
    w.push(1);
    w.push(2);
    assert.equal(w.length, 2);
    assert.equal(w.latest(), 2);
  });
});

describe("RollingBudget", () => {
  it("tracks total within window", () => {
    const b = new RollingBudget(60_000);
    b.add(100n);
    b.add(200n);
    assert.equal(b.total(), 300n);
  });

  it("prunes expired entries outside the window", () => {
    // Use a tiny window so entries expire immediately
    const b = new RollingBudget(1);
    b.add(100n);
    b.add(200n);

    // Wait just enough for entries to expire (> 1ms)
    const start = Date.now();
    while (Date.now() - start < 5) { /* busy-wait */ }

    // After pruning, old entries should be gone
    assert.equal(b.total(), 0n);
  });

  it("keeps recent entries and prunes only old ones", () => {
    const b = new RollingBudget(50);
    b.add(100n);

    const start = Date.now();
    while (Date.now() - start < 60) { /* busy-wait past window */ }

    b.add(500n);
    // The 100n entry should be pruned, only 500n remains
    assert.equal(b.total(), 500n);
  });
});

describe("bigAbs", () => {
  it("returns positive for negative", () => {
    assert.equal(bigAbs(-42n), 42n);
  });

  it("returns positive for positive", () => {
    assert.equal(bigAbs(42n), 42n);
  });

  it("returns 0 for 0", () => {
    assert.equal(bigAbs(0n), 0n);
  });
});
