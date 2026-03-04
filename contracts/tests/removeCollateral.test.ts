import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits } from "viem";
import { deployPerpsWithCollateralFixture, deployPerpsWithOrdersFixture } from "./fixtures.ts";

const { viem, networkHelpers } = await network.connect();

describe("PerpsSimple - removeCollateral", function () {
  it("should remove collateral successfully", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps, usdcMock } = contracts;
    const { buyer } = accounts;

    const amount = parseUnits("100", 6);

    const usdcBalanceBefore = await usdcMock.read.balanceOf([buyer.account.address]);
    const perpsBalanceBefore = await perps.read.balanceOf([buyer.account.address]);

    await perps.write.removeCollateral([amount], { account: buyer.account });

    const usdcBalanceAfter = await usdcMock.read.balanceOf([buyer.account.address]);
    const perpsBalanceAfter = await perps.read.balanceOf([buyer.account.address]);

    assert.equal(usdcBalanceAfter - usdcBalanceBefore, amount);
    assert.equal(perpsBalanceBefore - perpsBalanceAfter, amount);
  });

  it("should revert on zero amount", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    await viem.assertions.revertWithCustomError(
      perps.write.removeCollateral([0n], { account: buyer.account }),
      perps,
      "InvalidSize",
    );
  });

  it("should revert when insufficient balance", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    const tooMuch = config.collateralPerUser + parseUnits("1", 6);

    await viem.assertions.revertWithCustomError(
      perps.write.removeCollateral([tooMuch], { account: buyer.account }),
      perps,
      "InsufficientCollateral",
    );
  });

  it("should revert when margin requirement not met", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithOrdersFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    const requiredMargin = await perps.read.getRequiredMargin([buyer.account.address]);
    assert.ok(requiredMargin > 0n);

    const balance = await perps.read.balanceOf([buyer.account.address]);

    await viem.assertions.revertWithCustomError(
      perps.write.removeCollateral([balance], { account: buyer.account }),
      perps,
      "InsufficientMargin",
    );
  });

  it("should allow partial withdrawal when margin is still covered", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithOrdersFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    const balance = await perps.read.balanceOf([buyer.account.address]);
    const requiredMargin = await perps.read.getRequiredMargin([buyer.account.address]);

    const excessMargin = balance - requiredMargin;
    if (excessMargin > 0n) {
      const withdrawAmount = excessMargin / 2n;

      await perps.write.removeCollateral([withdrawAmount], { account: buyer.account });

      const balanceAfter = await perps.read.balanceOf([buyer.account.address]);
      assert.equal(balanceAfter, balance - withdrawAmount);
    }
  });

  it("should emit CollateralRemoved event", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { buyer, pc } = accounts;

    const amount = parseUnits("100", 6);

    const hash = await perps.write.removeCollateral([amount], { account: buyer.account });
    const receipt = await pc.waitForTransactionReceipt({ hash });

    const events = receipt.logs.filter(
      (log: any) => log.address.toLowerCase() === perps.address.toLowerCase(),
    );
    assert.ok(events.length > 0);
  });
});
