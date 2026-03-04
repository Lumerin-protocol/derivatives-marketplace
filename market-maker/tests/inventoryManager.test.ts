import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InventoryManager } from "../src/inventoryManager.ts";
import type { MakerConfig } from "../src/config.ts";

function makeConfig(overrides: Partial<MakerConfig> = {}): MakerConfig {
  return {
    perpsAddress: "0x0000000000000000000000000000000000000001",
    maxPositionSize: 100_000_000n,
    ...overrides,
  } as MakerConfig;
}

const noop = () => {};
function makeLogger(): never {
  return { child: () => ({ debug: noop, info: noop, warn: noop, error: noop }) } as never;
}

const MM_ADDRESS = "0x0000000000000000000000000000000000000099" as `0x${string}`;

describe("InventoryManager", () => {
  it("starts with zero values", () => {
    const inv = new InventoryManager({} as never, makeConfig(), MM_ADDRESS, makeLogger());
    assert.equal(inv.netQuantity, 0n);
    assert.equal(inv.collateralBalance, 0n);
    assert.equal(inv.inventorySkew, 0);
    assert.equal(inv.hasPosition, false);
    assert.equal(inv.absPosition, 0n);
  });

  it("hasPosition returns true for non-zero netQuantity", () => {
    const inv = new InventoryManager({} as never, makeConfig(), MM_ADDRESS, makeLogger());
    inv.netQuantity = 50_000_000n;
    assert.equal(inv.hasPosition, true);
  });

  it("hasPosition returns true for negative netQuantity", () => {
    const inv = new InventoryManager({} as never, makeConfig(), MM_ADDRESS, makeLogger());
    inv.netQuantity = -30_000_000n;
    assert.equal(inv.hasPosition, true);
  });

  it("absPosition returns absolute value of negative position", () => {
    const inv = new InventoryManager({} as never, makeConfig(), MM_ADDRESS, makeLogger());
    inv.netQuantity = -75_000_000n;
    assert.equal(inv.absPosition, 75_000_000n);
  });

  it("absPosition returns positive position unchanged", () => {
    const inv = new InventoryManager({} as never, makeConfig(), MM_ADDRESS, makeLogger());
    inv.netQuantity = 50_000_000n;
    assert.equal(inv.absPosition, 50_000_000n);
  });

  it("update sets fields from multicall results", async () => {
    const mockClient = {
      multicall: async () => [
        { status: "success", result: { netQuantity: 10_000_000n, aggregatedEntryPrice: 50_000_000n } },
        { status: "success", result: 500_000_000n },
        { status: "success", result: 100_000_000n },
      ],
    };
    const inv = new InventoryManager(mockClient as never, makeConfig(), MM_ADDRESS, makeLogger());
    await inv.update();

    assert.equal(inv.netQuantity, 10_000_000n);
    assert.equal(inv.entryPrice, 50_000_000n);
    assert.equal(inv.collateralBalance, 500_000_000n);
    assert.equal(inv.requiredMargin, 100_000_000n);
    assert.equal(inv.availableMargin, 400_000_000n);
    assert.equal(inv.utilizationPct, 20);
    assert.ok(inv.inventorySkew > 0, "positive net qty → positive skew");
  });

  it("update handles failed multicall results gracefully", async () => {
    const mockClient = {
      multicall: async () => [
        { status: "failure" },
        { status: "failure" },
        { status: "failure" },
      ],
    };
    const inv = new InventoryManager(mockClient as never, makeConfig(), MM_ADDRESS, makeLogger());
    await inv.update();

    assert.equal(inv.netQuantity, 0n);
    assert.equal(inv.collateralBalance, 0n);
    assert.equal(inv.utilizationPct, 0);
  });

  it("clamps inventory skew to [-1, 1]", async () => {
    const mockClient = {
      multicall: async () => [
        { status: "success", result: { netQuantity: 999_000_000n, aggregatedEntryPrice: 50_000_000n } },
        { status: "success", result: 1_000_000_000n },
        { status: "success", result: 0n },
      ],
    };
    const inv = new InventoryManager(mockClient as never, makeConfig({ maxPositionSize: 100_000_000n }), MM_ADDRESS, makeLogger());
    await inv.update();

    assert.equal(inv.inventorySkew, 1);
  });

  it("clamps negative inventory skew to -1", async () => {
    const mockClient = {
      multicall: async () => [
        { status: "success", result: { netQuantity: -999_000_000n, aggregatedEntryPrice: 50_000_000n } },
        { status: "success", result: 1_000_000_000n },
        { status: "success", result: 0n },
      ],
    };
    const inv = new InventoryManager(mockClient as never, makeConfig({ maxPositionSize: 100_000_000n }), MM_ADDRESS, makeLogger());
    await inv.update();

    assert.equal(inv.inventorySkew, -1);
  });

  it("sets availableMargin to 0 when requiredMargin exceeds collateral", async () => {
    const mockClient = {
      multicall: async () => [
        { status: "success", result: { netQuantity: 0n, aggregatedEntryPrice: 0n } },
        { status: "success", result: 100_000_000n },
        { status: "success", result: 200_000_000n },
      ],
    };
    const inv = new InventoryManager(mockClient as never, makeConfig(), MM_ADDRESS, makeLogger());
    await inv.update();

    assert.equal(inv.availableMargin, 0n);
  });

  it("sets skew to 0 when maxPositionSize is 0", async () => {
    const mockClient = {
      multicall: async () => [
        { status: "success", result: { netQuantity: 10_000_000n, aggregatedEntryPrice: 50_000_000n } },
        { status: "success", result: 500_000_000n },
        { status: "success", result: 100_000_000n },
      ],
    };
    const inv = new InventoryManager(mockClient as never, makeConfig({ maxPositionSize: 0n }), MM_ADDRESS, makeLogger());
    await inv.update();

    assert.equal(inv.inventorySkew, 0);
  });
});
