import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits, zeroAddress } from "viem";
import { TimeInForce } from "../fixtures/timeInForce.ts";
import { deployPerpsFixture, deployPerpsWithCollateralFixture } from "./fixtures.ts";

const { viem, networkHelpers } = await network.getOrCreate();

describe("HashPowerPerpsDEX - Admin Functions", function () {
  describe("setOracle", function () {
    it("should allow owner to set new oracle", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { owner } = accounts;

      const newPrice = parseUnits("100000", 6);
      const newOracle = await viem.deployContract("PriceOracleMock", [newPrice, 6]);

      await perps.write.setOracle([newOracle.address], { account: owner.account });

      const marketPrice = await perps.read.getMarketPrice();
      // Oracle already quotes 1 PH/s/day; mark is the answer scaled to collateral decimals.
      assert.equal(marketPrice, newPrice);
    });

    it("should revert when non-owner tries to set oracle", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
      const { perps, priceOracle } = contracts;
      const { buyer } = accounts;

      await viem.assertions.revertWithCustomError(
        perps.write.setOracle([priceOracle.address], { account: buyer.account }),
        perps,
        "OwnableUnauthorizedAccount",
      );
    });

    it("should revert when setting zero address", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { owner } = accounts;

      await viem.assertions.revertWithCustomError(
        perps.write.setOracle([zeroAddress], { account: owner.account }),
        perps,
        "InvalidOracle",
      );
    });
  });

  describe("setShocks (PME risk params)", function () {
    it("should allow owner to update portfolio margin shocks", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
      const { pme } = contracts;
      const { owner } = accounts;

      await pme.write.setShocks(
        [BigInt(0.2e18), BigInt(0.1e18), BigInt(0.15e18), BigInt(0.08e18)],
        { account: owner.account },
      );

      assert.equal(await pme.read.imSpotShock(), BigInt(0.2e18));
      assert.equal(await pme.read.mmSpotShock(), BigInt(0.1e18));
    });

    it("should revert when non-owner tries to set shocks", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
      const { pme } = contracts;
      const { buyer } = accounts;

      await viem.assertions.revertWithCustomError(
        pme.write.setShocks([BigInt(0.2e18), BigInt(0.1e18), BigInt(0.15e18), BigInt(0.08e18)], {
          account: buyer.account,
        }),
        pme,
        "OwnableUnauthorizedAccount",
      );
    });
  });

  describe("setLiquidationFeeBps", function () {
    it("should allow owner to set liquidation fee bps", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { owner } = accounts;

      const newFeeBps = 200; // 2%
      await perps.write.setLiquidationFeeBps([newFeeBps], { account: owner.account });

      const liquidationFeeBps = await perps.read.liquidationFeeBps();
      assert.equal(liquidationFeeBps, newFeeBps);
    });

    it("should revert when non-owner tries to set", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      await viem.assertions.revertWithCustomError(
        perps.write.setLiquidationFeeBps([200], { account: buyer.account }),
        perps,
        "OwnableUnauthorizedAccount",
      );
    });

    it("should allow setting to 0", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { owner } = accounts;

      await perps.write.setLiquidationFeeBps([0], { account: owner.account });

      const liquidationFeeBps = await perps.read.liquidationFeeBps();
      assert.equal(liquidationFeeBps, 0);
    });
  });

  describe("match fee setters (setTakerFeeBps / setMakerFeeBps)", function () {
    it("should allow owner to set maker and taker fees", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { owner } = accounts;

      await perps.write.setTakerFeeBps([10], { account: owner.account });
      await perps.write.setMakerFeeBps([2], { account: owner.account });

      const takerFeeBps = await perps.read.takerFeeBps();
      const makerFeeBps = await perps.read.makerFeeBps();
      assert.equal(takerFeeBps, 10);
      assert.equal(makerFeeBps, 2);
    });

    it("should revert when non-owner tries to set", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      await viem.assertions.revertWithCustomError(
        perps.write.setTakerFeeBps([10], { account: buyer.account }),
        perps,
        "OwnableUnauthorizedAccount",
      );
      await viem.assertions.revertWithCustomError(
        perps.write.setMakerFeeBps([2], { account: buyer.account }),
        perps,
        "OwnableUnauthorizedAccount",
      );
    });

    it("accepts a fee at MAX_FEE_BPS and rejects one bp beyond it", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { owner } = accounts;

      await perps.write.setTakerFeeBps([100], { account: owner.account });
      assert.equal(await perps.read.takerFeeBps(), 100);

      await viem.assertions.revertWithCustomError(
        perps.write.setTakerFeeBps([101], { account: owner.account }),
        perps,
        "InvalidFee",
      );
      // 5% would exactly match the MM spot shock, collapsing the coverage argument the
      // cap exists to protect.
      await viem.assertions.revertWithCustomError(
        perps.write.setMakerFeeBps([500], { account: owner.account }),
        perps,
        "InvalidFee",
      );
      await viem.assertions.revertWithCustomError(
        perps.write.setMakerFeeBps([-101], { account: owner.account }),
        perps,
        "InvalidFee",
      );
    });

    it("rejects a maker rebate that makes the pair a net outflow", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { owner } = accounts;

      await perps.write.setTakerFeeBps([30], { account: owner.account });
      // −30 nets to zero and is fine; −31 would pay out more than the match collects.
      await perps.write.setMakerFeeBps([-30], { account: owner.account });
      await viem.assertions.revertWithCustomError(
        perps.write.setMakerFeeBps([-31], { account: owner.account }),
        perps,
        "InvalidFee",
      );
      // Same bound seen from the taker side: lowering the taker fee under the standing
      // rebate is equally an outflow.
      await viem.assertions.revertWithCustomError(
        perps.write.setTakerFeeBps([29], { account: owner.account }),
        perps,
        "InvalidFee",
      );
    });
  });

  describe("withdrawCollectedFees", function () {
    it("allows only the owner to withdraw accrued venue revenue", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(
        deployPerpsWithCollateralFixture,
      );
      const { perps, usdcMock, vault } = contracts;
      const { owner, buyer, seller } = accounts;
      const price = await perps.read.getMarketPrice();
      const quantity = parseUnits("1", config.quantityDecimals);

      await perps.write.createOrder([price, -quantity, TimeInForce.GTC], {
        account: seller.account,
      });
      await perps.write.createOrder([price, quantity, TimeInForce.GTC], {
        account: buyer.account,
      });

      const revenue = await perps.read.collectedFeesBalance();
      assert.ok(revenue > 0n);
      assert.equal(await vault.read.balanceOf([perps.address]), revenue);

      const ownerBalanceBefore = await usdcMock.read.balanceOf([owner.account.address]);
      await perps.write.withdrawCollectedFees({ account: owner.account });

      assert.equal(await perps.read.collectedFeesBalance(), 0n);
      assert.equal(await vault.read.balanceOf([perps.address]), 0n);
      assert.equal(
        await usdcMock.read.balanceOf([owner.account.address]),
        ownerBalanceBefore + revenue,
      );
    });

    it("rejects a non-owner withdrawal", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      await viem.assertions.revertWithCustomError(
        perps.write.withdrawCollectedFees({ account: buyer.account }),
        perps,
        "OwnableUnauthorizedAccount",
      );
    });
  });

  describe("depositInsuranceFund", function () {
    it("anyone can top up the insurance fund", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
      const { vault } = contracts;
      const { owner } = accounts;

      const amount = parseUnits("1000", 6);
      const reserveBefore = await vault.read.insuranceFundBalance();

      await vault.write.depositInsuranceFund([amount], { account: owner.account });

      const reserveAfter = await vault.read.insuranceFundBalance();
      assert.equal(reserveAfter - reserveBefore, amount);
    });

    it("pulls tokens from the caller", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
      const { vault, usdcMock } = contracts;
      const { owner } = accounts;

      const amount = parseUnits("500", 6);
      const ownerBalanceBefore = await usdcMock.read.balanceOf([owner.account.address]);
      const vaultBalanceBefore = await usdcMock.read.balanceOf([vault.address]);

      await vault.write.depositInsuranceFund([amount], { account: owner.account });

      const ownerBalanceAfter = await usdcMock.read.balanceOf([owner.account.address]);
      const vaultBalanceAfter = await usdcMock.read.balanceOf([vault.address]);

      assert.equal(ownerBalanceBefore - ownerBalanceAfter, amount);
      assert.equal(vaultBalanceAfter - vaultBalanceBefore, amount);
    });
  });

  describe("withdrawInsuranceFund", function () {
    it("should allow owner to withdraw from insurance fund", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
      const { vault } = contracts;
      const { owner } = accounts;

      const amount = parseUnits("1000", 6);
      const reserveBefore = await vault.read.insuranceFundBalance();

      await vault.write.withdrawInsuranceFund([owner.account.address, amount], { account: owner.account });

      const reserveAfter = await vault.read.insuranceFundBalance();
      assert.equal(reserveBefore - reserveAfter, amount);
    });

    it("should revert when non-owner tries to withdraw", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
      const { vault } = contracts;
      const { buyer } = accounts;

      await viem.assertions.revertWithCustomError(
        vault.write.withdrawInsuranceFund([buyer.account.address, parseUnits("100", 6)], { account: buyer.account }),
        vault,
        "OwnableUnauthorizedAccount",
      );
    });

    it("should revert when withdrawing more than available", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
      const { vault } = contracts;
      const { owner } = accounts;

      const reserve = await vault.read.insuranceFundBalance();
      const tooMuch = reserve + parseUnits("1", 6);

      await viem.assertions.revertWithCustomError(
        vault.write.withdrawInsuranceFund([owner.account.address, tooMuch], { account: owner.account }),
        vault,
        "ERC20InsufficientBalance",
      );
    });

    it("should transfer tokens to recipient", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
      const { vault, usdcMock } = contracts;
      const { owner } = accounts;

      const amount = parseUnits("500", 6);
      const ownerBalanceBefore = await usdcMock.read.balanceOf([owner.account.address]);

      await vault.write.withdrawInsuranceFund([owner.account.address, amount], { account: owner.account });

      const ownerBalanceAfter = await usdcMock.read.balanceOf([owner.account.address]);
      assert.equal(ownerBalanceAfter - ownerBalanceBefore, amount);
    });
  });

  describe("contract size (fixed compile-time constant)", function () {
    it("exposes CONTRACT_SIZE_HPS_DAY = 1e15 (1 PH/s/day)", async function () {
      const { contracts } = await networkHelpers.loadFixture(deployPerpsFixture);
      const { perps } = contracts;

      assert.equal(await perps.read.CONTRACT_SIZE_HPS_DAY(), 10n ** 15n);
    });

    it("mark equals the oracle answer when decimals match (no unit rebase)", async function () {
      const { contracts, config } = await networkHelpers.loadFixture(deployPerpsFixture);
      const { perps } = contracts;

      // Oracle and collateral both use 6 decimals, so the mark is exactly the oracle answer.
      const marketPrice = await perps.read.getMarketPrice();
      assert.equal(marketPrice, config.oracle.price);
    });
  });
});
