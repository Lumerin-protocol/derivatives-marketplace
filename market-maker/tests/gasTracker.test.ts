import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GasTracker } from "../src/gasTracker.ts";
import type { MakerConfig } from "../src/config.ts";
import { PublicClient } from "viem";

const noop = () => {};
function makeLogger(): never {
  return { child: () => ({ debug: noop, info: noop, warn: noop, error: noop }) } as never;
}

function makeConfig(overrides: Partial<MakerConfig> = {}): MakerConfig {
  return {
    perpsAddress: "0x0000000000000000000000000000000000000001",
    gasSpikeThresholdPct: 200,
    gasCapMultiplier: 2.0,
    gasPenaltyBps: 5,
    ethPriceFeedAddress: undefined,
    ...overrides,
  } as MakerConfig;
}

describe("GasTracker", () => {
  it("starts with default values", () => {
    const tracker = new GasTracker({} as never, makeConfig(), makeLogger());
    assert.equal(tracker.currentGasPrice, 0n);
    assert.equal(tracker.medianGasPrice, 0);
    assert.equal(tracker.gasSpikePct, 0);
    assert.equal(tracker.isGasSpiking, false);
    assert.equal(tracker.ethPriceUsd, 0n);
    assert.equal(tracker.estimatedCreateGas, 300_000n);
    assert.equal(tracker.estimatedCancelGas, 100_000n);
  });

  it("update() reads gas price and computes median/spike", async () => {
    let callCount = 0;
    const prices = [1_000_000_000n, 1_000_000_000n, 1_000_000_000n, 1_000_000_000n, 5_000_000_000n];
    const mockClient = {
      getGasPrice: async () => prices[callCount++],
    } as PublicClient;

    const tracker = new GasTracker(mockClient, makeConfig(), makeLogger());
    for (let i = 0; i < prices.length; i++) {
      await tracker.update();
    }

    assert.equal(tracker.currentGasPrice, 5_000_000_000n);
    assert.ok(tracker.gasSpikePct > 100, "should detect spike");
    assert.ok(tracker.isGasSpiking, "should be spiking");
  });

  it("update() reports no spike when prices are stable", async () => {
    const mockClient = { getGasPrice: async () => 1_000_000_000n } as PublicClient;
    const tracker = new GasTracker(mockClient, makeConfig(), makeLogger());

    for (let i = 0; i < 10; i++) await tracker.update();

    assert.equal(tracker.isGasSpiking, false);
    assert.ok(tracker.gasSpikePct <= 0);
  });

  it("update() handles median = 0 gracefully (first sample)", async () => {
    let first = true;
    const mockClient = {
      getGasPrice: async () => {
        if (first) {
          first = false;
          return 0n;
        }
        return 1_000_000_000n;
      },
    } as PublicClient;
    const tracker = new GasTracker(mockClient, makeConfig(), makeLogger());
    await tracker.update();
    assert.equal(tracker.gasSpikePct, 0);
  });

  it("update() fetches ETH price when ethPriceFeedAddress is set", async () => {
    const mockClient = {
      getGasPrice: async () => 1_000_000_000n,
      multicall: async () => {
        return [[0n, 200_000_000_000n, 0n, 0n, 0n], 8]; // $2000 with 8 decimals
      },
    } as unknown as PublicClient;

    const config = makeConfig({
      ethPriceFeedAddress: "0x0000000000000000000000000000000000000002" as `0x${string}`,
    });
    const tracker = new GasTracker(mockClient, config, makeLogger());
    await tracker.update();

    assert.equal(tracker.ethPriceUsd, 2_000_000_000n);
  });

  it("handles ETH price feed failure gracefully", async () => {
    const mockClient = {
      getGasPrice: async () => 1_000_000_000n,
      readContract: async () => {
        throw new Error("rpc error");
      },
    };

    const config = makeConfig({
      ethPriceFeedAddress: "0x0000000000000000000000000000000000000002" as `0x${string}`,
    });
    const tracker = new GasTracker(mockClient as never, config, makeLogger());
    await tracker.update();
    assert.equal(tracker.ethPriceUsd, 0n);
  });

  it("handles ETH price with fewer than 6 decimals", async () => {
    const mockClient = {
      getGasPrice: async () => 1_000_000_000n,
      multicall: async () => {
        return [[0n, 2000n, 0n, 0n, 0n], 0n]; // $2000 with 0 decimals
      },
    };

    const config = makeConfig({
      ethPriceFeedAddress: "0x0000000000000000000000000000000000000002" as `0x${string}`,
    });
    const tracker = new GasTracker(mockClient as never, config, makeLogger());
    await tracker.update();

    // 2000 * 10^6 = 2_000_000_000
    assert.equal(tracker.ethPriceUsd, 2_000_000_000n);
  });

  it("handles negative ETH price (ignores it)", async () => {
    const mockClient = {
      getGasPrice: async () => 1_000_000_000n,
      readContract: async (args: { functionName: string }) => {
        if (args.functionName === "latestRoundData") {
          return [0n, -100n, 0n, 0n, 0n];
        }
        if (args.functionName === "decimals") return 8;
        return 0n;
      },
    };

    const config = makeConfig({
      ethPriceFeedAddress: "0x0000000000000000000000000000000000000002" as `0x${string}`,
    });
    const tracker = new GasTracker(mockClient as never, config, makeLogger());
    await tracker.update();
    assert.equal(tracker.ethPriceUsd, 0n);
  });
});

describe("GasTracker.calibrate", () => {
  it("updates estimatedCreateGas on success", async () => {
    const mockClient = {
      estimateContractGas: async () => 250_000n,
    };
    const tracker = new GasTracker(mockClient as never, makeConfig(), makeLogger());
    await tracker.calibrate("0x1234" as `0x${string}`);

    assert.equal(tracker.estimatedCreateGas, 250_000n);
  });

  it("keeps defaults when estimation fails", async () => {
    const mockClient = {
      estimateContractGas: async () => {
        throw new Error("no orders");
      },
    };
    const tracker = new GasTracker(mockClient as never, makeConfig(), makeLogger());
    await tracker.calibrate("0x1234" as `0x${string}`);

    assert.equal(tracker.estimatedCreateGas, 300_000n);
  });

  it("only calibrates once", async () => {
    let calls = 0;
    const mockClient = {
      estimateContractGas: async () => {
        calls++;
        return 250_000n;
      },
    };
    const tracker = new GasTracker(mockClient as never, makeConfig(), makeLogger());
    await tracker.calibrate("0x1234" as `0x${string}`);
    await tracker.calibrate("0x1234" as `0x${string}`);

    assert.equal(calls, 1);
  });
});

describe("GasTracker cost calculations", () => {
  it("placeCostUsd returns 0 when ethPriceUsd is 0", () => {
    const tracker = new GasTracker({} as never, makeConfig(), makeLogger());
    assert.equal(tracker.placeCostUsd, 0n);
    assert.equal(tracker.cancelCostUsd, 0n);
    assert.equal(tracker.roundTripCostUsd, 0n);
  });

  it("computes placeCostUsd correctly", () => {
    const tracker = new GasTracker({} as never, makeConfig(), makeLogger());
    tracker.ethPriceUsd = 2_000_000_000n; // $2000
    tracker.currentGasPrice = 1_000_000_000n; // 1 gwei

    // 300_000 * 1e9 * 2e9 / 1e18 = 600_000
    assert.equal(tracker.placeCostUsd, 600_000n);
  });

  it("computes cancelCostUsd correctly", () => {
    const tracker = new GasTracker({} as never, makeConfig(), makeLogger());
    tracker.ethPriceUsd = 2_000_000_000n;
    tracker.currentGasPrice = 1_000_000_000n;

    // 100_000 * 1e9 * 2e9 / 1e18 = 200_000
    assert.equal(tracker.cancelCostUsd, 200_000n);
  });

  it("roundTripCostUsd = cancel + place", () => {
    const tracker = new GasTracker({} as never, makeConfig(), makeLogger());
    tracker.ethPriceUsd = 2_000_000_000n;
    tracker.currentGasPrice = 1_000_000_000n;

    assert.equal(tracker.roundTripCostUsd, 800_000n);
  });

  it("requoteCycleCostUsd scales by totalOrders", () => {
    const tracker = new GasTracker({} as never, makeConfig(), makeLogger());
    tracker.ethPriceUsd = 2_000_000_000n;
    tracker.currentGasPrice = 1_000_000_000n;

    const rt = tracker.roundTripCostUsd;
    assert.equal(tracker.requoteCycleCostUsd(10), rt * 10n);
  });
});

describe("GasTracker.cappedGasPrice", () => {
  it("returns cap when current gas is below cap", () => {
    const mockClient = { getGasPrice: async () => 1_000_000_000n };
    const tracker = new GasTracker(
      mockClient as never,
      makeConfig({ gasCapMultiplier: 2.0 }),
      makeLogger(),
    );

    tracker.currentGasPrice = 1_000_000_000n;
    tracker.medianGasPrice = 1_000_000_000;

    const capped = tracker.cappedGasPrice();
    // cap = median(1G) * 2.0 = 2G; current(1G) < cap(2G) → returns cap
    assert.equal(capped, 2_000_000_000n);
  });

  it("returns current gas price when spiking above cap (never below base fee)", () => {
    const tracker = new GasTracker(
      {} as never,
      makeConfig({ gasCapMultiplier: 2.0 }),
      makeLogger(),
    );

    tracker.currentGasPrice = 10_000_000_000n;
    tracker.medianGasPrice = 1_000_000_000;

    const capped = tracker.cappedGasPrice();
    // cap = 2G; current(10G) > cap(2G) → returns current to avoid tx failure
    assert.equal(capped, 10_000_000_000n);
  });

  it("returns current gas price when median is 0", () => {
    const tracker = new GasTracker(
      {} as never,
      makeConfig({ gasCapMultiplier: 2.0 }),
      makeLogger(),
    );

    tracker.currentGasPrice = 1_000_000_000n;
    tracker.medianGasPrice = 0;

    const capped = tracker.cappedGasPrice();
    assert.equal(capped, 1_000_000_000n);
  });
});
