import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { encodeFunctionData, getAddress, parseUnits, zeroAddress } from "viem";
import { deployPerpsWithCollateralFixture } from "./fixtures.ts";

const { viem, networkHelpers } = await network.connect();

const ORACLE_DECIMALS = 8;
const LIVE_PRICE = parseUnits("50", ORACLE_DECIMALS);

async function deployVault(collateralToken: `0x${string}`) {
  const impl = await viem.deployContract("CollateralVault", []);
  const proxy = await viem.deployContract("ERC1967Proxy", [
    impl.address,
    encodeFunctionData({ abi: impl.abi, functionName: "initialize", args: [collateralToken] }),
  ]);
  return await viem.getContractAt("CollateralVault", proxy.address);
}

/** A second engine, aggregating whichever vault it is pointed at. */
async function deployEngine(vaultAddress: `0x${string}`) {
  const impl = await viem.deployContract("PortfolioMarginEngine", []);
  const proxy = await viem.deployContract("ERC1967Proxy", [
    impl.address,
    encodeFunctionData({ abi: impl.abi, functionName: "initialize", args: [] }),
  ]);
  const pme = await viem.getContractAt("PortfolioMarginEngine", proxy.address);
  await pme.write.setVault([vaultAddress]);
  return pme;
}

async function deployUninitializedPerps(vaultAddress: `0x${string}`) {
  const impl = await viem.deployContract("HashPowerPerpsDEX", [vaultAddress]);
  const proxy = await viem.deployContract("ERC1967Proxy", [impl.address, "0x"]);
  return await viem.getContractAt("HashPowerPerpsDEX", proxy.address);
}

async function deployCapabilityMock(vaultAddress: `0x${string}`, failingCapability: number) {
  return await viem.deployContract("PortfolioMarginEngineDependencyMock", [
    vaultAddress,
    failingCapability,
  ]);
}

describe("HashPowerPerpsDEX - dependency validation", function () {
  describe("initializers", function () {
    it("initialize accepts the historical signature when its vault matches the immutable", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(
        deployPerpsWithCollateralFixture,
      );
      const { vault, priceOracle } = contracts;
      const { owner } = accounts;
      const perps = await deployUninitializedPerps(vault.address);

      await perps.write.initialize([priceOracle.address, vault.address]);

      assert.equal(await perps.read.vault(), getAddress(vault.address));
      assert.equal(await perps.read.owner(), getAddress(owner.account.address));
    });

    it("initialize rejects a supplied vault that differs from the immutable", async function () {
      const { contracts } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { vault, priceOracle, usdcMock } = contracts;
      const perps = await deployUninitializedPerps(vault.address);
      const strayVault = await deployVault(usdcMock.address);

      await viem.assertions.revertWithCustomError(
        perps.write.initialize([priceOracle.address, strayVault.address]),
        perps,
        "VaultMismatch",
      );
    });

    it("initializeV2 rejects a supplied vault that differs from the immutable", async function () {
      const { contracts } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps, pme, usdcMock } = contracts;
      const strayVault = await deployVault(usdcMock.address);

      await viem.assertions.revertWithCustomError(
        perps.write.initializeV2([strayVault.address, pme.address]),
        perps,
        "VaultMismatch",
      );
    });

    it("initializeV2 permits zero PME for atomic upgrades that wire it later", async function () {
      const { contracts } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps, vault } = contracts;

      await perps.write.initializeV2([vault.address, zeroAddress]);

      assert.equal(await perps.read.portfolioMargin(), zeroAddress);
    });

    it("initializeV2 validates a nonzero PME through the setter path", async function () {
      const { contracts } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps, vault } = contracts;
      const missingImShock = await deployCapabilityMock(vault.address, 3);

      await viem.assertions.revertWithCustomError(
        perps.write.initializeV2([vault.address, missingImShock.address]),
        perps,
        "InvalidDependency",
      );
    });

    it("initializeV2 adopts a valid nonzero PME", async function () {
      const { contracts } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps, vault } = contracts;
      const engine = await deployEngine(vault.address);

      await perps.write.initializeV2([vault.address, engine.address]);

      assert.equal(await perps.read.portfolioMargin(), getAddress(engine.address));
    });
  });

  describe("setPortfolioMargin", function () {
    it("rejects the zero address", async function () {
      const { contracts } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;

      await viem.assertions.revertWithCustomError(
        perps.write.setPortfolioMargin([zeroAddress]),
        perps,
        "ZeroAddress",
      );
    });

    it("rejects an address holding no code", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(
        deployPerpsWithCollateralFixture,
      );
      const { perps } = contracts;
      const { buyer } = accounts;

      await viem.assertions.revertWithCustomError(
        perps.write.setPortfolioMargin([buyer.account.address]),
        perps,
        "InvalidDependency",
      );
    });

    it("rejects a contract lacking the margin-engine surface", async function () {
      const { contracts } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps, usdcMock } = contracts;

      await viem.assertions.revertWithCustomError(
        perps.write.setPortfolioMargin([usdcMock.address]),
        perps,
        "InvalidDependency",
      );
    });

    it("rejects an engine aggregating a different vault", async function () {
      const { contracts } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps, usdcMock } = contracts;
      const strayEngine = await deployEngine((await deployVault(usdcMock.address)).address);

      await viem.assertions.revertWithCustomError(
        perps.write.setPortfolioMargin([strayEngine.address]),
        perps,
        "VaultMismatch",
      );
    });

    it("probes every PME capability used by venue risk validation", async function () {
      const { contracts } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps, vault } = contracts;

      for (const failingCapability of [1, 2, 3, 4]) {
        const incompleteEngine = await deployCapabilityMock(vault.address, failingCapability);
        await viem.assertions.revertWithCustomError(
          perps.write.setPortfolioMargin([incompleteEngine.address]),
          perps,
          "InvalidDependency",
        );
      }
    });

    it("accepts an engine aggregating the venue's own vault", async function () {
      const { contracts } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps, vault } = contracts;
      const engine = await deployEngine(vault.address);

      await perps.write.setPortfolioMargin([engine.address]);
      assert.equal(await perps.read.portfolioMargin(), getAddress(engine.address));
    });
  });

  describe("setOracle", function () {
    it("rejects the zero address", async function () {
      const { contracts } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;

      await viem.assertions.revertWithCustomError(
        perps.write.setOracle([zeroAddress]),
        perps,
        "InvalidOracle",
      );
    });

    it("rejects an address holding no code", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(
        deployPerpsWithCollateralFixture,
      );
      const { perps } = contracts;
      const { buyer } = accounts;

      await viem.assertions.revertWithCustomError(
        perps.write.setOracle([buyer.account.address]),
        perps,
        "InvalidDependency",
      );
    });

    it("rejects a contract that does not answer latestRoundData", async function () {
      const { contracts } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps, usdcMock } = contracts;

      await viem.assertions.revertWithCustomError(
        perps.write.setOracle([usdcMock.address]),
        perps,
        "InvalidDependency",
      );
    });

    it("rejects a feed that has never answered", async function () {
      const { contracts } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      // Reads as price 0, which would mark every open position at zero.
      const silentFeed = await viem.deployContract("PriceOracleMock", [0n, ORACLE_DECIMALS]);

      await viem.assertions.revertWithCustomError(
        perps.write.setOracle([silentFeed.address]),
        perps,
        "InvalidOracle",
      );
    });

    it("applies the same stale and invalid-round checks before adopting a feed", async function () {
      const { contracts } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const now = BigInt(await networkHelpers.time.latest());

      const staleFeed = await viem.deployContract("PriceOracleMock", [LIVE_PRICE, ORACLE_DECIMALS]);
      await staleFeed.write.setRoundData([LIVE_PRICE, 1n, now - 3601n, 1n]);
      await viem.assertions.revertWithCustomError(
        perps.write.setOracle([staleFeed.address]),
        perps,
        "OracleStale",
      );

      const invalidRounds = [
        { roundId: 0n, updatedAt: 0n, answeredInRound: 0n },
        { roundId: 1n, updatedAt: now + 1000n, answeredInRound: 1n },
      ] as const;
      for (const round of invalidRounds) {
        const feed = await viem.deployContract("PriceOracleMock", [LIVE_PRICE, ORACLE_DECIMALS]);
        await feed.write.setRoundData([
          LIVE_PRICE,
          round.roundId,
          round.updatedAt,
          round.answeredInRound,
        ]);
        await viem.assertions.revertWithCustomError(
          perps.write.setOracle([feed.address]),
          perps,
          "InvalidOracle",
        );
      }
    });

    it("accepts a live feed", async function () {
      const { contracts } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const feed = await viem.deployContract("PriceOracleMock", [LIVE_PRICE, ORACLE_DECIMALS]);

      await perps.write.setOracle([feed.address]);
      assert.equal(await perps.read.priceOracle(), getAddress(feed.address));
    });
  });
});
