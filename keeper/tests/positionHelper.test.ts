import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "viem";
import {
  computeLiquidationPrice,
  computeLiquidationState,
} from "../src/positionHelper.ts";

const QUANTITY_DECIMALS = 18n;
const D = 10n ** QUANTITY_DECIMALS;
const MAINTENANCE_PCT = 5n;

function price(n: string, decimals = 6) {
  return parseUnits(n, decimals);
}

describe("computeLiquidationPrice", () => {
  it("returns 0 for zero quantity", () => {
    const result = computeLiquidationPrice(0n, price("100"), price("50"), 0n, MAINTENANCE_PCT, QUANTITY_DECIMALS);
    assert.equal(result, 0n);
  });

  describe("long positions (positive quantity)", () => {
    it("returns price below entry for a well-collateralized long", () => {
      const entry = price("100");
      const qty = 1n * D;
      const collateral = price("50");
      const liqPrice = computeLiquidationPrice(qty, entry, collateral, 0n, MAINTENANCE_PCT, QUANTITY_DECIMALS);

      assert.ok(liqPrice > 0n, "Liq price should be positive");
      assert.ok(liqPrice < entry, "Long liq price should be below entry");
    });

    it("returns higher liq price with less collateral", () => {
      const entry = price("100");
      const qty = 1n * D;

      const liqHigh = computeLiquidationPrice(qty, entry, price("10"), 0n, MAINTENANCE_PCT, QUANTITY_DECIMALS);
      const liqLow = computeLiquidationPrice(qty, entry, price("50"), 0n, MAINTENANCE_PCT, QUANTITY_DECIMALS);

      assert.ok(liqHigh > liqLow, "Less collateral = higher (closer to market) liq price for longs");
    });

    it("returns higher liq price when order margin eats into available collateral", () => {
      const entry = price("100");
      const qty = 1n * D;
      const collateral = price("50");

      const liqNoMargin = computeLiquidationPrice(qty, entry, collateral, 0n, MAINTENANCE_PCT, QUANTITY_DECIMALS);
      const liqWithMargin = computeLiquidationPrice(qty, entry, collateral, price("20"), MAINTENANCE_PCT, QUANTITY_DECIMALS);

      assert.ok(liqWithMargin > liqNoMargin, "Order margin should raise liq price for longs");
    });

    it("handles order margin exceeding collateral gracefully", () => {
      const entry = price("100");
      const qty = 1n * D;
      const collateral = price("10");
      const orderMargin = price("20");

      const liqPrice = computeLiquidationPrice(qty, entry, collateral, orderMargin, MAINTENANCE_PCT, QUANTITY_DECIMALS);
      assert.ok(liqPrice >= 0n, "Should not return negative");
    });

    it("scales correctly with larger quantities", () => {
      const entry = price("100");
      const collateral = price("50");

      const liq1 = computeLiquidationPrice(1n * D, entry, collateral, 0n, MAINTENANCE_PCT, QUANTITY_DECIMALS);
      const liq10 = computeLiquidationPrice(10n * D, entry, collateral, 0n, MAINTENANCE_PCT, QUANTITY_DECIMALS);

      assert.ok(liq10 > liq1, "Larger position = higher liq price (closer to market) for longs");
    });

    it("liq price approaches entry with minimal collateral", () => {
      const entry = price("100");
      const qty = 1n * D;
      const tinyCollateral = price("0.01");

      const liqPrice = computeLiquidationPrice(qty, entry, tinyCollateral, 0n, MAINTENANCE_PCT, QUANTITY_DECIMALS);
      const distanceToEntry = entry - liqPrice;
      assert.ok(distanceToEntry < price("5"), "Liq price should be very close to entry");
    });
  });

  describe("short positions (negative quantity)", () => {
    it("returns price above entry for a well-collateralized short", () => {
      const entry = price("100");
      const qty = -1n * D;
      const collateral = price("50");

      const liqPrice = computeLiquidationPrice(qty, entry, collateral, 0n, MAINTENANCE_PCT, QUANTITY_DECIMALS);
      assert.ok(liqPrice > 0n, "Liq price should be positive");
      assert.ok(liqPrice > entry, "Short liq price should be above entry");
    });

    it("returns lower liq price with less collateral", () => {
      const entry = price("100");
      const qty = -1n * D;

      const liqHigh = computeLiquidationPrice(qty, entry, price("50"), 0n, MAINTENANCE_PCT, QUANTITY_DECIMALS);
      const liqLow = computeLiquidationPrice(qty, entry, price("10"), 0n, MAINTENANCE_PCT, QUANTITY_DECIMALS);

      assert.ok(liqLow < liqHigh, "Less collateral = lower (closer to market) liq price for shorts");
    });

    it("returns lower liq price when order margin eats into available collateral", () => {
      const entry = price("100");
      const qty = -1n * D;
      const collateral = price("50");

      const liqNoMargin = computeLiquidationPrice(qty, entry, collateral, 0n, MAINTENANCE_PCT, QUANTITY_DECIMALS);
      const liqWithMargin = computeLiquidationPrice(qty, entry, collateral, price("20"), MAINTENANCE_PCT, QUANTITY_DECIMALS);

      assert.ok(liqWithMargin < liqNoMargin, "Order margin should lower liq price for shorts");
    });

    it("scales correctly with larger quantities", () => {
      const entry = price("100");
      const collateral = price("50");

      const liq1 = computeLiquidationPrice(-1n * D, entry, collateral, 0n, MAINTENANCE_PCT, QUANTITY_DECIMALS);
      const liq10 = computeLiquidationPrice(-10n * D, entry, collateral, 0n, MAINTENANCE_PCT, QUANTITY_DECIMALS);

      assert.ok(liq10 < liq1, "Larger position = lower liq price (closer to market) for shorts");
    });
  });

  describe("maintenance margin percentage effects", () => {
    it("higher maintenance margin makes liquidation easier (liq price closer to entry)", () => {
      const entry = price("100");
      const qty = 1n * D;
      const collateral = price("50");

      const liq5 = computeLiquidationPrice(qty, entry, collateral, 0n, 5n, QUANTITY_DECIMALS);
      const liq20 = computeLiquidationPrice(qty, entry, collateral, 0n, 20n, QUANTITY_DECIMALS);

      assert.ok(liq20 > liq5, "Higher maint% = higher liq price for longs");
    });

    it("works with zero maintenance margin percent", () => {
      const entry = price("100");
      const qty = 1n * D;
      const collateral = price("50");

      const liqPrice = computeLiquidationPrice(qty, entry, collateral, 0n, 0n, QUANTITY_DECIMALS);
      assert.ok(liqPrice >= 0n);
    });
  });

  describe("symmetry", () => {
    it("long and short liq prices bracket the entry price for equal collateral", () => {
      const entry = price("100");
      const collateral = price("20");

      const longLiq = computeLiquidationPrice(1n * D, entry, collateral, 0n, MAINTENANCE_PCT, QUANTITY_DECIMALS);
      const shortLiq = computeLiquidationPrice(-1n * D, entry, collateral, 0n, MAINTENANCE_PCT, QUANTITY_DECIMALS);

      assert.ok(longLiq < entry, "Long liq < entry");
      assert.ok(shortLiq > entry, "Short liq > entry");
    });
  });

  describe("different quantity decimals", () => {
    it("works with small quantity decimals", () => {
      const qDecimals = 2n;
      const qty = 100n; // 1.00
      const entry = price("100");
      const collateral = price("50");

      const liqPrice = computeLiquidationPrice(qty, entry, collateral, 0n, MAINTENANCE_PCT, qDecimals);
      assert.ok(liqPrice > 0n);
      assert.ok(liqPrice < entry);
    });
  });
});

describe("computeLiquidationState", () => {
  it("derives order margin and liquidation price from total maintenance margin", () => {
    const qty = 1n * D;
    const entry = price("100");
    const collateral = price("50");
    const marketPrice = price("100");
    const totalMaintenanceMargin = price("10"); // includes order + position components

    const result = computeLiquidationState(
      qty, entry, collateral, totalMaintenanceMargin, marketPrice, MAINTENANCE_PCT, QUANTITY_DECIMALS,
    );

    assert.ok(result.orderMargin >= 0n, "Order margin should be non-negative");
    assert.ok(result.liquidationPrice > 0n, "Liquidation price should be positive");
    assert.ok(result.liquidationPrice < entry, "Long liq price should be below entry");
  });

  it("returns zero order margin when position component exceeds total", () => {
    const qty = 1n * D;
    const entry = price("100");
    const collateral = price("50");
    const marketPrice = price("50"); // massive unrealized loss for long
    const totalMaintenanceMargin = price("1");

    const result = computeLiquidationState(
      qty, entry, collateral, totalMaintenanceMargin, marketPrice, MAINTENANCE_PCT, QUANTITY_DECIMALS,
    );

    assert.equal(result.orderMargin, 0n, "Order margin should be clamped to 0");
  });

  it("correctly handles short positions", () => {
    const qty = -1n * D;
    const entry = price("100");
    const collateral = price("50");
    const marketPrice = price("100");
    const totalMaintenanceMargin = price("10");

    const result = computeLiquidationState(
      qty, entry, collateral, totalMaintenanceMargin, marketPrice, MAINTENANCE_PCT, QUANTITY_DECIMALS,
    );

    assert.ok(result.orderMargin >= 0n);
    assert.ok(result.liquidationPrice > entry, "Short liq price should be above entry");
  });

  it("zero quantity returns zero liquidation price", () => {
    const result = computeLiquidationState(
      0n, price("100"), price("50"), price("5"), price("100"), MAINTENANCE_PCT, QUANTITY_DECIMALS,
    );
    assert.equal(result.liquidationPrice, 0n);
  });

  it("order margin increases when maintenance margin is high relative to position value", () => {
    const qty = 1n * D;
    const entry = price("100");
    const collateral = price("50");
    const marketPrice = price("100");

    const resultLow = computeLiquidationState(
      qty, entry, collateral, price("6"), marketPrice, MAINTENANCE_PCT, QUANTITY_DECIMALS,
    );
    const resultHigh = computeLiquidationState(
      qty, entry, collateral, price("20"), marketPrice, MAINTENANCE_PCT, QUANTITY_DECIMALS,
    );

    assert.ok(resultHigh.orderMargin > resultLow.orderMargin);
  });

  it("higher order margin shifts liquidation price closer to market", () => {
    const qty = 1n * D;
    const entry = price("100");
    const collateral = price("50");
    const marketPrice = price("100");

    const resultLow = computeLiquidationState(
      qty, entry, collateral, price("6"), marketPrice, MAINTENANCE_PCT, QUANTITY_DECIMALS,
    );
    const resultHigh = computeLiquidationState(
      qty, entry, collateral, price("20"), marketPrice, MAINTENANCE_PCT, QUANTITY_DECIMALS,
    );

    assert.ok(resultHigh.liquidationPrice > resultLow.liquidationPrice,
      "Higher order margin = higher liq price for longs");
  });
});
