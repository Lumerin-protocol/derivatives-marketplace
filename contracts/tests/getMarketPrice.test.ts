import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits } from "viem";
import { deployPerpsFixture } from "./fixtures.ts";
import { roundToNearest } from "../lib/round.ts";

const { viem, networkHelpers } = await network.connect();

describe("HashPowerPerpsDEX - getMarketPrice", function () {
  it("should return the oracle price", async function () {
    const { contracts, config } = await networkHelpers.loadFixture(deployPerpsFixture);
    const { perps } = contracts;

    const expectedPrice = roundToNearest(config.oracle.price, config.minimumPriceIncrement);
    const marketPrice = await perps.read.getMarketPrice();
    assert.equal(marketPrice, expectedPrice);
  });

  it("should return updated price when oracle changes", async function () {
    const { contracts, config } = await networkHelpers.loadFixture(deployPerpsFixture);
    const { perps, priceOracle } = contracts;

    const newPrice = config.oracle.price + config.minimumPriceIncrement;
    await priceOracle.write.setPrice([newPrice, config.oracle.decimals]);
    const expectedPrice = roundToNearest(newPrice, config.minimumPriceIncrement);

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
    await priceOracle.write.setPrice([newPrice, 6n]);

    const marketPrice = await perps.read.getMarketPrice();
    assert.equal(marketPrice, newPrice);
  });
});
