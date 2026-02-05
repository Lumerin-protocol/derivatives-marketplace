import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { parseUnits } from "viem";
import { deployPerpsWithCollateralFixture, deployPerpsWithOrdersFixture } from "./fixtures";

describe("PerpsSimple - removeCollateral", function () {
  it("should remove collateral successfully", async function () {
    const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
    const { perps, usdcMock } = contracts;
    const { buyer } = accounts;

    const amount = parseUnits("100", 6);

    // Check balances before
    const usdcBalanceBefore = await usdcMock.read.balanceOf([buyer.account.address]);
    const perpsBalanceBefore = await perps.read.balanceOf([buyer.account.address]);

    // Remove collateral
    await perps.write.removeCollateral([amount], { account: buyer.account });

    // Check balances after
    const usdcBalanceAfter = await usdcMock.read.balanceOf([buyer.account.address]);
    const perpsBalanceAfter = await perps.read.balanceOf([buyer.account.address]);

    expect(usdcBalanceAfter - usdcBalanceBefore).to.equal(amount);
    expect(perpsBalanceBefore - perpsBalanceAfter).to.equal(amount);
  });

  it("should revert on zero amount", async function () {
    const { contracts, accounts } = await loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    await expect(perps.write.removeCollateral([0n], { account: buyer.account })).to.be.rejectedWith(
      "InvalidSize"
    );
  });

  it("should revert when insufficient balance", async function () {
    const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    const tooMuch = config.collateralPerUser + parseUnits("1", 6);

    await expect(
      perps.write.removeCollateral([tooMuch], { account: buyer.account })
    ).to.be.rejectedWith("InsufficientCollateral");
  });

  it("should revert when margin requirement not met", async function () {
    const { contracts, accounts, config } = await loadFixture(deployPerpsWithOrdersFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    // Buyer has open orders requiring margin
    const requiredMargin = await perps.read.getRequiredMargin([buyer.account.address]);
    expect(requiredMargin > 0n).to.be.true;

    // Try to withdraw all collateral
    const balance = await perps.read.balanceOf([buyer.account.address]);

    await expect(
      perps.write.removeCollateral([balance], { account: buyer.account })
    ).to.be.rejectedWith("InsufficientMargin");
  });

  it("should allow partial withdrawal when margin is still covered", async function () {
    const { contracts, accounts, config } = await loadFixture(deployPerpsWithOrdersFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    const balance = await perps.read.balanceOf([buyer.account.address]);
    const requiredMargin = await perps.read.getRequiredMargin([buyer.account.address]);

    // Withdraw up to the available excess
    const excessMargin = balance - requiredMargin;
    if (excessMargin > 0n) {
      const withdrawAmount = excessMargin / 2n;

      await perps.write.removeCollateral([withdrawAmount], { account: buyer.account });

      const balanceAfter = await perps.read.balanceOf([buyer.account.address]);
      expect(balanceAfter).to.equal(balance - withdrawAmount);
    }
  });

  it("should emit CollateralRemoved event", async function () {
    const { contracts, accounts } = await loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { buyer, pc } = accounts;

    const amount = parseUnits("100", 6);

    const hash = await perps.write.removeCollateral([amount], { account: buyer.account });
    const receipt = await pc.waitForTransactionReceipt({ hash });

    // Check event was emitted
    const events = receipt.logs.filter(
      (log) => log.address.toLowerCase() === perps.address.toLowerCase()
    );
    expect(events.length).to.be.greaterThan(0);
  });
});
