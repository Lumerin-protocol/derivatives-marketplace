import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import {
  deployPerpsWithCollateralFixture,
  deployPerpsWithOrdersFixture,
  deployPerpsWithPositionsFixture,
  deployPerpsWithLiquidatablePositionFixture,
} from "./fixtures";

describe("PerpsSimple - Margin View Functions", function () {
  describe("getRequiredMargin", function () {
    it("should return 0 when user has no orders or positions", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      const margin = await perps.read.getRequiredMargin([buyer.account.address]);
      expect(margin).to.equal(0n);
    });

    it("should include margin for open orders", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsWithOrdersFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      const margin = await perps.read.getRequiredMargin([buyer.account.address]);
      expect(margin > 0n).to.be.true;
    });

    it("should include margin for open positions", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsWithPositionsFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      const margin = await perps.read.getRequiredMargin([buyer.account.address]);
      expect(margin > 0n).to.be.true;
    });

    it("should increase when price moves against position", async function () {
      const data = await loadFixture(deployPerpsWithLiquidatablePositionFixture);
      const { contracts, accounts } = data;
      const { perps, priceOracle } = contracts;
      const { seller } = accounts;

      // Seller has a short position
      const marginBefore = await perps.read.getRequiredMargin([seller.account.address]);

      // Price goes up (bad for short)
      const currentPrice = await perps.read.getMarketPrice();
      const newPrice = (currentPrice * 110n) / 100n;
      await priceOracle.write.setPrice([newPrice, 6]);

      const marginAfter = await perps.read.getRequiredMargin([seller.account.address]);
      expect(marginAfter > marginBefore).to.be.true;
    });

    it("should decrease when price moves in favor of position", async function () {
      const data = await loadFixture(deployPerpsWithLiquidatablePositionFixture);
      const { contracts, accounts } = data;
      const { perps, priceOracle } = contracts;
      const { seller } = accounts;

      // Seller has a short position
      const marginBefore = await perps.read.getRequiredMargin([seller.account.address]);

      // Price goes down (good for short)
      const currentPrice = await perps.read.getMarketPrice();
      const newPrice = (currentPrice * 90n) / 100n;
      await priceOracle.write.setPrice([newPrice, 6]);

      const marginAfter = await perps.read.getRequiredMargin([seller.account.address]);
      expect(marginAfter <= marginBefore).to.be.true;
    });
  });

  describe("getMaintenanceMargin", function () {
    it("should return 0 when user has no orders or positions", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      const margin = await perps.read.getMaintenanceMargin([buyer.account.address]);
      expect(margin).to.equal(0n);
    });

    it("should be less than required margin for positions", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsWithPositionsFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      const requiredMargin = await perps.read.getRequiredMargin([buyer.account.address]);
      const maintenanceMargin = await perps.read.getMaintenanceMargin([buyer.account.address]);

      // Maintenance margin should be lower (uses lower percentage)
      expect(maintenanceMargin <= requiredMargin).to.be.true;
    });
  });

  describe("isLiquidatable", function () {
    it("should return false for user with no position", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      const isLiquidatable = await perps.read.isLiquidatable([buyer.account.address]);
      expect(isLiquidatable).to.be.false;
    });

    it("should return false for healthy position", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsWithPositionsFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      const isLiquidatable = await perps.read.isLiquidatable([buyer.account.address]);
      expect(isLiquidatable).to.be.false;
    });

    it("should return true for underwater position", async function () {
      const data = await loadFixture(deployPerpsWithLiquidatablePositionFixture);
      const { contracts, accounts } = data;
      const { perps } = contracts;
      const { seller } = accounts;

      // Before price move - should not be liquidatable
      let isLiquidatable = await perps.read.isLiquidatable([seller.account.address]);
      expect(isLiquidatable).to.be.false;

      // Move price to make position underwater
      await data.makeLiquidatable();

      // After price move - should be liquidatable
      isLiquidatable = await perps.read.isLiquidatable([seller.account.address]);
      expect(isLiquidatable).to.be.true;
    });

    it("should correctly identify liquidatable when balance < maintenance margin", async function () {
      const data = await loadFixture(deployPerpsWithLiquidatablePositionFixture);
      const { contracts, accounts } = data;
      const { perps } = contracts;
      const { seller } = accounts;

      await data.makeLiquidatable();

      const balance = await perps.read.balanceOf([seller.account.address]);
      const maintenanceMargin = await perps.read.getMaintenanceMargin([seller.account.address]);

      expect(balance < maintenanceMargin).to.be.true;
      expect(await perps.read.isLiquidatable([seller.account.address])).to.be.true;
    });
  });
});
