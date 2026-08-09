import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { encodeFunctionData, parseUnits } from "viem";
import { deployPerpsFixture } from "./fixtures.ts";
import { roundToNearest } from "../lib/round.ts";

const { viem, networkHelpers } = await network.connect();

describe("HashPowerPerpsDEX - getMarketPrice", function () {
  it("should return the oracle price scaled to collateral decimals", async function () {
    const { contracts, config } = await networkHelpers.loadFixture(deployPerpsFixture);
    const { perps } = contracts;

    // Mark = oracle answer scaled to collateral decimals, then rounded to the
    // minimum price increment. Oracle already quotes 1 PH/s/day (= contract size).
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

  it("accepts the exact staleness boundary and exposes it", async function () {
    const { contracts } = await networkHelpers.loadFixture(deployPerpsFixture);
    const { perps, priceOracle } = contracts;
    const maxStaleness = await perps.read.MAX_ORACLE_STALENESS();
    assert.equal(maxStaleness, 3600n);

    await priceOracle.write.freezeTimestamp();
    await networkHelpers.time.increase(Number(maxStaleness));
    assert.ok((await perps.read.getMarketPrice()) > 0n);

    await networkHelpers.time.increase(1);
    await viem.assertions.revertWithCustomError(perps.read.getMarketPrice(), perps, "OracleStale");
  });

  it("rejects zero, negative, uninitialized, and future rounds", async function () {
    const { contracts, config } = await networkHelpers.loadFixture(deployPerpsFixture);
    const { perps, priceOracle } = contracts;
    const now = BigInt(await networkHelpers.time.latest());

    const invalidRounds = [
      { price: 0n, roundId: 1n, updatedAt: now, answeredInRound: 1n },
      { price: -1n, roundId: 1n, updatedAt: now, answeredInRound: 1n },
      { price: config.oracle.price, roundId: 0n, updatedAt: 0n, answeredInRound: 0n },
      { price: config.oracle.price, roundId: 1n, updatedAt: now + 1000n, answeredInRound: 1n },
    ] as const;

    for (const round of invalidRounds) {
      await priceOracle.write.setRoundData([
        round.price,
        round.roundId,
        round.updatedAt,
        round.answeredInRound,
      ]);
      await viem.assertions.revertWithCustomError(
        perps.read.getMarketPrice(),
        perps,
        "InvalidOracle",
      );
    }
  });

  it("scales oracle values both down and up to six decimals", async function () {
    const { contracts } = await networkHelpers.loadFixture(deployPerpsFixture);
    const { perps } = contracts;

    const eightDecimalFeed = await viem.deployContract("PriceOracleMock", [
      parseUnits("85000", 8),
      8,
    ]);
    await perps.write.setOracle([eightDecimalFeed.address]);
    assert.equal(await perps.read.getMarketPrice(), parseUnits("85000", 6));

    const fourDecimalFeed = await viem.deployContract("PriceOracleMock", [
      parseUnits("85000", 4),
      4,
    ]);
    await perps.write.setOracle([fourDecimalFeed.address]);
    assert.equal(await perps.read.getMarketPrice(), parseUnits("85000", 6));
  });

  it("requires six-decimal collateral", async function () {
    async function deployVault(decimals: number) {
      const collateral = await viem.deployContract("CollateralTokenMock", [decimals]);
      const vaultImpl = await viem.deployContract("CollateralVault", []);
      const vaultProxy = await viem.deployContract("ERC1967Proxy", [
        vaultImpl.address,
        encodeFunctionData({
          abi: vaultImpl.abi,
          functionName: "initialize",
          args: [collateral.address],
        }),
      ]);
      return await viem.getContractAt("CollateralVault", vaultProxy.address);
    }

    const sixDecimalVault = await deployVault(6);
    await viem.deployContract("HashPowerPerpsDEX", [sixDecimalVault.address]);

    const eighteenDecimalVault = await deployVault(18);
    await assert.rejects(
      viem.deployContract("HashPowerPerpsDEX", [eighteenDecimalVault.address]),
      /InvalidCollateralDecimals/,
    );
  });

  it("exposes CONTRACT_SIZE_HPS_DAY matching the oracle quote basis (1 PH/s/day)", async function () {
    const { contracts, config } = await networkHelpers.loadFixture(deployPerpsFixture);
    const { perps } = contracts;

    const contractSize = await perps.read.CONTRACT_SIZE_HPS_DAY();
    assert.equal(contractSize, 10n ** 15n, "one contract settles 1 PH/s/day");

    // Oracle and collateral both use 6 decimals here — mark equals the oracle answer.
    const marketPrice = await perps.read.getMarketPrice();
    const expected = roundToNearest(config.oracle.price, config.minimumPriceIncrement);
    assert.equal(marketPrice, expected);
  });
});
