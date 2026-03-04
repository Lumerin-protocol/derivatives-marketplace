import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OracleTracker } from "../src/oracleTracker.ts";
import type { MakerConfig } from "../src/config.ts";

function makeConfig(): MakerConfig {
  return {
    perpsAddress: "0x0000000000000000000000000000000000000001",
  } as MakerConfig;
}

const noop = () => {};
function makeLogger(): never {
  return { child: () => ({ debug: noop, info: noop, warn: noop, error: noop }) } as never;
}

describe("OracleTracker", () => {
  it("starts with zero price and volatility", () => {
    const tracker = new OracleTracker({} as never, makeConfig(), makeLogger());
    assert.equal(tracker.currentPrice, 0n);
    assert.equal(tracker.volatility, 0);
  });

  it("updates price from contract read", async () => {
    const mockClient = {
      readContract: async () => 100_000_000n,
    };
    const tracker = new OracleTracker(mockClient as never, makeConfig(), makeLogger());

    await tracker.update();
    assert.equal(tracker.currentPrice, 100_000_000n);
  });

  it("tracks volatility across multiple updates", async () => {
    let callCount = 0;
    const prices = [100_000_000n, 101_000_000n, 99_000_000n, 102_000_000n];
    const mockClient = {
      readContract: async () => prices[callCount++],
    };
    const tracker = new OracleTracker(mockClient as never, makeConfig(), makeLogger());

    for (let i = 0; i < prices.length; i++) {
      await tracker.update();
    }
    assert.ok(tracker.volatility > 0, "should have non-zero volatility after enough samples");
  });

  it("volatility is 0 with fewer than 3 samples", async () => {
    let callCount = 0;
    const prices = [100_000_000n, 101_000_000n];
    const mockClient = {
      readContract: async () => prices[callCount++],
    };
    const tracker = new OracleTracker(mockClient as never, makeConfig(), makeLogger());

    await tracker.update();
    await tracker.update();
    assert.equal(tracker.volatility, 0);
  });
});
