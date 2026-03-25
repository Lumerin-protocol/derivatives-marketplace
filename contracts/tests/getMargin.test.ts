import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import {
  deployPerpsWithCollateralFixture,
  deployPerpsWithOrdersFixture,
  deployPerpsWithPositionsFixture,
  deployPerpsWithLiquidatablePositionFixture,
} from "./fixtures.ts";

const { viem, networkHelpers } = await network.connect();

describe("HashPowerPerpsDEX - Margin View Functions", function () {
  describe("getMaintenanceMargin", function () {
    it("should return 0 when user has no orders or positions", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      const margin = await perps.read.getMaintenanceMargin([buyer.account.address]);
      assert.equal(margin, 0n);
    });

    it("should include margin for open orders", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithOrdersFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      const margin = await perps.read.getMaintenanceMargin([buyer.account.address]);
      assert.ok(margin > 0n);
    });

    it("should include margin for open positions", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithPositionsFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      const margin = await perps.read.getMaintenanceMargin([buyer.account.address]);
      assert.ok(margin > 0n);
    });

    it("should increase when price moves against position", async function () {
      const data = await networkHelpers.loadFixture(deployPerpsWithLiquidatablePositionFixture);
      const { contracts, accounts } = data;
      const { perps, priceOracle } = contracts;
      const { seller } = accounts;

      const marginBefore = await perps.read.getMaintenanceMargin([seller.account.address]);

      const currentPrice = await perps.read.getMarketPrice();
      const newPrice = (currentPrice * 110n) / 100n;
      await priceOracle.write.setPrice([newPrice, 6]);

      const marginAfter = await perps.read.getMaintenanceMargin([seller.account.address]);
      assert.ok(marginAfter > marginBefore);
    });

    it("should decrease when price moves in favor of position", async function () {
      const data = await networkHelpers.loadFixture(deployPerpsWithLiquidatablePositionFixture);
      const { contracts, accounts } = data;
      const { perps, priceOracle } = contracts;
      const { seller } = accounts;

      const marginBefore = await perps.read.getMaintenanceMargin([seller.account.address]);

      const currentPrice = await perps.read.getMarketPrice();
      const newPrice = (currentPrice * 90n) / 100n;
      await priceOracle.write.setPrice([newPrice, 6]);

      const marginAfter = await perps.read.getMaintenanceMargin([seller.account.address]);
      assert.ok(marginAfter <= marginBefore);
    });
  });

  describe("isLiquidatable", function () {
    it("should return false for user with no position", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      const isLiquidatable = await perps.read.isLiquidatable([buyer.account.address]);
      assert.ok(!isLiquidatable);
    });

    it("should return false for healthy position", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithPositionsFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      const isLiquidatable = await perps.read.isLiquidatable([buyer.account.address]);
      assert.ok(!isLiquidatable);
    });

    it("should return true for underwater position", async function () {
      const data = await networkHelpers.loadFixture(deployPerpsWithLiquidatablePositionFixture);
      const { contracts, accounts } = data;
      const { perps } = contracts;
      const { seller } = accounts;

      let isLiquidatable = await perps.read.isLiquidatable([seller.account.address]);
      assert.ok(!isLiquidatable);

      await data.makeLiquidatable();

      isLiquidatable = await perps.read.isLiquidatable([seller.account.address]);
      assert.ok(isLiquidatable);
    });

    it("should correctly identify liquidatable when balance < maintenance margin", async function () {
      const data = await networkHelpers.loadFixture(deployPerpsWithLiquidatablePositionFixture);
      const { contracts, accounts } = data;
      const { perps } = contracts;
      const { seller } = accounts;

      await data.makeLiquidatable();

      const balance = await perps.read.balanceOf([seller.account.address]);
      const maintenanceMargin = await perps.read.getMaintenanceMargin([seller.account.address]);

      assert.ok(balance < maintenanceMargin);
      assert.ok(await perps.read.isLiquidatable([seller.account.address]));
    });
  });
});
