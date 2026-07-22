import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits } from "viem";
import { deployPerpsFixture, MARK_MULTIPLIER } from "./fixtures.ts";
import { roundToNearest } from "../lib/round.ts";

const { viem, networkHelpers } = await network.connect();

describe("HashPowerPerpsDEX - getMarketPrice", function () {
  it("should return the oracle price rebased by the fixed contract size", async function () {
    const { contracts, config } = await networkHelpers.loadFixture(deployPerpsFixture);
    const { perps } = contracts;

    // Mark = oracle answer (scaled to collateral decimals) x (CONTRACT_SIZE_HPS_DAY /
    // ORACLE_UNIT_HPS_DAY), then rounded to the minimum price increment.
    const expectedPrice = roundToNearest(
      config.oracle.price * MARK_MULTIPLIER,
      config.minimumPriceIncrement,
    );
    const marketPrice = await perps.read.getMarketPrice();
    assert.equal(marketPrice, expectedPrice);
  });

  it("should return updated price when oracle changes", async function () {
    const { contracts, config } = await networkHelpers.loadFixture(deployPerpsFixture);
    const { perps, priceOracle } = contracts;

    const newPrice = config.oracle.price + config.minimumPriceIncrement;
    await priceOracle.write.setPrice([newPrice, config.oracle.decimals]);
    const expectedPrice = roundToNearest(
      newPrice * MARK_MULTIPLIER,
      config.minimumPriceIncrement,
    );

    const marketPrice = await perps.read.getMarketPrice();
    assert.equal(marketPrice, expectedPrice);
  });

  it("should revert when oracle price is stale", async function () {
    const { contracts } = await networkHelpers.loadFixture(deployPerpsFixture);
    const { perps, priceOracle } = contracts;

    await priceOracle.write.freezeTimestamp();

    await networkHelpers.time.increase(3601);

    await viem.assertions.revertWithCustomError(perps.read.getMarketPrice(), perps, "OracleStale");
  });

  it("should handle different decimal precision from oracle", async function () {
    const { contracts } = await networkHelpers.loadFixture(deployPerpsFixture);
    const { perps, priceOracle } = contracts;

    const newPrice = parseUnits("85000", 6);
    await priceOracle.write.setPrice([newPrice, 6]);

    const marketPrice = await perps.read.getMarketPrice();
    assert.equal(marketPrice, newPrice * MARK_MULTIPLIER);
  });

  it("applies the fixed CONTRACT_SIZE_HPS_DAY / ORACLE_UNIT_HPS_DAY (x10) factor", async function () {
    const { contracts, config } = await networkHelpers.loadFixture(deployPerpsFixture);
    const { perps } = contracts;

    const contractSize = await perps.read.CONTRACT_SIZE_HPS_DAY();
    const oracleUnit = await perps.read.ORACLE_UNIT_HPS_DAY();
    assert.equal(contractSize, 10n ** 15n, "one contract settles 1 PH/s/day");
    assert.equal(oracleUnit, 100n * 10n ** 12n, "oracle quotes 100 TH/s/day");
    assert.equal(contractSize / oracleUnit, MARK_MULTIPLIER);

    // getMarketPrice() == oracle-derived price (scaled to collateral decimals)
    // x (contractSize / oracleUnit). Oracle and collateral both use 6 decimals here.
    const marketPrice = await perps.read.getMarketPrice();
    const expected = roundToNearest(
      (config.oracle.price * contractSize) / oracleUnit,
      config.minimumPriceIncrement,
    );
    assert.equal(marketPrice, expected);
    assert.equal(marketPrice, config.oracle.price * MARK_MULTIPLIER);
  });
});
