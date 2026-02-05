import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { parseUnits } from "viem";
import { deployPerpsFixture } from "./fixtures";

describe("PerpsSimple - getMarketPrice", function () {
  it("should return the oracle price", async function () {
    const { contracts, config } = await loadFixture(deployPerpsFixture);
    const { perps, priceOracle } = contracts;

    const marketPrice = await perps.read.getMarketPrice();
    expect(marketPrice).to.equal(config.oracle.btcPrice);
  });

  it("should return updated price when oracle changes", async function () {
    const { contracts } = await loadFixture(deployPerpsFixture);
    const { perps, priceOracle } = contracts;

    const newPrice = parseUnits("90000", 6);
    await priceOracle.write.setPrice([newPrice, 6n]);

    const marketPrice = await perps.read.getMarketPrice();
    expect(marketPrice).to.equal(newPrice);
  });

  it("should revert when oracle price is stale", async function () {
    const { contracts } = await loadFixture(deployPerpsFixture);
    const { perps, priceOracle } = contracts;

    // Freeze the oracle timestamp at the current time
    await priceOracle.write.freezeTimestamp();

    // Advance time by more than MAX_ORACLE_STALENESS (1 hour)
    await time.increase(3601);

    await expect(perps.read.getMarketPrice()).to.be.rejectedWith("OracleStale");
  });

  it("should handle different decimal precision from oracle", async function () {
    const { contracts, config } = await loadFixture(deployPerpsFixture);
    const { perps, priceOracle } = contracts;

    // Set price with same decimals
    const newPrice = parseUnits("85000", 6);
    await priceOracle.write.setPrice([newPrice, 6n]);

    const marketPrice = await perps.read.getMarketPrice();
    expect(marketPrice).to.equal(newPrice);
  });
});
