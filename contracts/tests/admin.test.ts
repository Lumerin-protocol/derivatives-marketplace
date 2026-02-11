import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { parseUnits, zeroAddress } from "viem";
import { deployPerpsFixture, deployPerpsWithCollateralFixture } from "./fixtures";
import { viem } from "hardhat";
import { catchError } from "../lib/lib";

describe("PerpsSimple - Admin Functions", function () {
  describe("setOracle", function () {
    it("should allow owner to set new oracle", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { owner } = accounts;

      // Deploy a new mock oracle with proper timestamp handling
      const newPrice = parseUnits("100000", 6);
      const newOracle = await viem.deployContract("contracts/PriceOracleMock.sol:PriceOracleMock", [
        newPrice,
        6,
      ]);

      await perps.write.setOracle([newOracle.address], { account: owner.account });

      const marketPrice = await perps.read.getMarketPrice();
      expect(marketPrice).to.equal(newPrice);
    });

    it("should revert when non-owner tries to set oracle", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsFixture);
      const { perps, priceOracle } = contracts;
      const { buyer } = accounts;

      await expect(
        perps.write.setOracle([priceOracle.address], { account: buyer.account }),
      ).to.be.rejectedWith("OwnableUnauthorizedAccount");
    });

    it("should revert when setting zero address", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { owner } = accounts;

      await expect(
        perps.write.setOracle([zeroAddress], { account: owner.account }),
      ).to.be.rejectedWith("InvalidOracle");
    });
  });

  describe("setMarginPercent", function () {
    it("should allow owner to set margin percent", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { owner } = accounts;

      await perps.write.setMarginPercent([20], { account: owner.account });

      const marginPercent = await perps.read.marginPercent();
      expect(marginPercent).to.equal(20);
    });

    it("should revert when non-owner tries to set margin percent", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      await expect(
        perps.write.setMarginPercent([20], { account: buyer.account }),
      ).to.be.rejectedWith("OwnableUnauthorizedAccount");
    });

    it("should revert when margin percent is 0", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { owner } = accounts;

      await expect(
        perps.write.setMarginPercent([0], { account: owner.account }),
      ).to.be.rejectedWith("InvalidMarginPercent");
    });

    it("should revert when margin percent is greater than 100", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { owner } = accounts;

      await expect(
        perps.write.setMarginPercent([101], { account: owner.account }),
      ).to.be.rejectedWith("InvalidMarginPercent");
    });

    it("should revert when margin percent is less than maintenance margin", async function () {
      const { contracts, accounts, config } = await loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { owner } = accounts;

      // Maintenance margin is 5%, try to set margin to 5% (not greater)
      await expect(
        perps.write.setMarginPercent([config.maintenanceMarginPercent], {
          account: owner.account,
        }),
      ).to.be.rejectedWith("InvalidMarginPercent");
    });
  });

  describe("setMaintenanceMarginPercent", function () {
    it("should allow owner to set maintenance margin percent", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { owner } = accounts;

      const margin = 3;

      await perps.write.setMaintenanceMarginPercent([margin], { account: owner.account });

      const maintenanceMarginPercent = await perps.read.maintenanceMarginPercent();
      expect(maintenanceMarginPercent).to.equal(margin);
    });

    it("should revert when non-owner tries to set", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      await expect(
        perps.write.setMaintenanceMarginPercent([3], { account: buyer.account }),
      ).to.be.rejectedWith("OwnableUnauthorizedAccount");
    });

    it("should revert when maintenance margin is 0", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { owner } = accounts;

      await expect(
        perps.write.setMaintenanceMarginPercent([0], { account: owner.account }),
      ).to.be.rejectedWith("InvalidMarginPercent");
    });

    it("should revert when maintenance margin >= margin percent", async function () {
      const { contracts, accounts, config } = await loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { owner } = accounts;

      // Try to set maintenance margin equal to margin percent
      await expect(
        perps.write.setMaintenanceMarginPercent([config.marginPercent], {
          account: owner.account,
        }),
      ).to.be.rejectedWith("InvalidMarginPercent");
    });
  });

  describe("setLiquidationFee", function () {
    it("should allow owner to set liquidation fee", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { owner } = accounts;

      const newFee = parseUnits("20", 6);
      await perps.write.setLiquidationFee([newFee], { account: owner.account });

      const liquidationFee = await perps.read.liquidationFee();
      expect(liquidationFee).to.equal(newFee);
    });

    it("should revert when non-owner tries to set", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      await expect(
        perps.write.setLiquidationFee([parseUnits("20", 6)], { account: buyer.account }),
      ).to.be.rejectedWith("OwnableUnauthorizedAccount");
    });

    it("should allow setting to 0", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { owner } = accounts;

      await perps.write.setLiquidationFee([0n], { account: owner.account });

      const liquidationFee = await perps.read.liquidationFee();
      expect(liquidationFee).to.equal(0n);
    });
  });

  describe("setMatchFee", function () {
    it("should allow owner to set maker and taker fees", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { owner } = accounts;

      await perps.write.setMatchFee([10, 2], { account: owner.account });

      const takerFeeBps = await perps.read.takerFeeBps();
      const makerFeeBps = await perps.read.makerFeeBps();
      expect(takerFeeBps).to.equal(10);
      expect(makerFeeBps).to.equal(2);
    });

    it("should revert when non-owner tries to set", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      await expect(perps.write.setMatchFee([10, 0], { account: buyer.account })).to.be.rejectedWith(
        "OwnableUnauthorizedAccount",
      );
    });
  });

  describe("depositReservePool", function () {
    it("should allow anyone to deposit to reserve pool", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      const amount = parseUnits("1000", 6);
      const reserveBefore = await perps.read.balanceOf([perps.address]);

      await perps.write.depositReservePool([amount], { account: buyer.account });

      const reserveAfter = await perps.read.balanceOf([perps.address]);
      expect(reserveAfter - reserveBefore).to.equal(amount);
    });

    it("should transfer tokens from depositor to contract", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsFixture);
      const { perps, usdcMock } = contracts;
      const { buyer } = accounts;

      const amount = parseUnits("500", 6);
      const buyerBalanceBefore = await usdcMock.read.balanceOf([buyer.account.address]);
      const contractBalanceBefore = await usdcMock.read.balanceOf([perps.address]);

      await perps.write.depositReservePool([amount], { account: buyer.account });

      const buyerBalanceAfter = await usdcMock.read.balanceOf([buyer.account.address]);
      const contractBalanceAfter = await usdcMock.read.balanceOf([perps.address]);

      expect(buyerBalanceBefore - buyerBalanceAfter).to.equal(amount);
      expect(contractBalanceAfter - contractBalanceBefore).to.equal(amount);
    });
  });

  describe("withdrawReservePool", function () {
    it("should allow owner to withdraw from reserve pool", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { owner } = accounts;

      const amount = parseUnits("1000", 6);
      const reserveBefore = await perps.read.balanceOf([perps.address]);

      await perps.write.withdrawReservePool([amount], { account: owner.account });

      const reserveAfter = await perps.read.balanceOf([perps.address]);
      expect(reserveBefore - reserveAfter).to.equal(amount);
    });

    it("should revert when non-owner tries to withdraw", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      await expect(
        perps.write.withdrawReservePool([parseUnits("100", 6)], { account: buyer.account }),
      ).to.be.rejectedWith("OwnableUnauthorizedAccount");
    });

    it("should revert when withdrawing more than available", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { owner } = accounts;

      const reserve = await perps.read.balanceOf([perps.address]);
      const tooMuch = reserve + parseUnits("1", 6);

      await catchError(perps.abi, "InsufficientReservePool", async () => {
        await perps.write.withdrawReservePool([tooMuch], { account: owner.account });
      });
    });

    it("should transfer tokens to owner", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsFixture);
      const { perps, usdcMock } = contracts;
      const { owner } = accounts;

      const amount = parseUnits("500", 6);
      const ownerBalanceBefore = await usdcMock.read.balanceOf([owner.account.address]);

      await perps.write.withdrawReservePool([amount], { account: owner.account });

      const ownerBalanceAfter = await usdcMock.read.balanceOf([owner.account.address]);
      expect(ownerBalanceAfter - ownerBalanceBefore).to.equal(amount);
    });
  });
});
