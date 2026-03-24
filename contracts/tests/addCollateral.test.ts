import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, parseEventLogs, parseUnits } from "viem";
import { deployPerpsFixture } from "./fixtures.ts";

const { viem, networkHelpers } = await network.connect();

describe("HashPowerPerpsDEX - addCollateral", function () {
  it("should add collateral successfully", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
    const { perps, usdcMock } = contracts;
    const { buyer } = accounts;

    const amount = parseUnits("1000", 6);

    const usdcBalanceBefore = await usdcMock.read.balanceOf([buyer.account.address]);
    const perpsBalanceBefore = await perps.read.balanceOf([buyer.account.address]);

    await perps.write.addCollateral([amount], { account: buyer.account });

    const usdcBalanceAfter = await usdcMock.read.balanceOf([buyer.account.address]);
    const perpsBalanceAfter = await perps.read.balanceOf([buyer.account.address]);

    assert.equal(usdcBalanceBefore - usdcBalanceAfter, amount);
    assert.equal(perpsBalanceAfter - perpsBalanceBefore, amount);
  });

  it("should revert on zero amount", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    await viem.assertions.revertWithCustomError(
      perps.write.addCollateral([0n], { account: buyer.account }),
      perps,
      "InvalidSize",
    );
  });

  it("should emit CollateralAdded event", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
    const { perps } = contracts;
    const { buyer, pc } = accounts;

    const amount = parseUnits("1000", 6);

    const hash = await perps.write.addCollateral([amount], { account: buyer.account });
    const receipt = await pc.waitForTransactionReceipt({ hash });

    const [collateralAddedEvent] = parseEventLogs({
      logs: receipt.logs,
      abi: perps.abi,
      eventName: "CollateralAdded",
    });

    assert.ok(collateralAddedEvent != null);
    assert.equal(collateralAddedEvent.args.user, getAddress(buyer.account.address));
    assert.equal(collateralAddedEvent.args.amount, amount);
  });

  it("should transfer tokens from user to contract", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
    const { perps, usdcMock } = contracts;
    const { buyer } = accounts;

    const amount = parseUnits("500", 6);

    const contractBalanceBefore = await usdcMock.read.balanceOf([perps.address]);

    await perps.write.addCollateral([amount], { account: buyer.account });

    const contractBalanceAfter = await usdcMock.read.balanceOf([perps.address]);
    assert.equal(contractBalanceAfter - contractBalanceBefore, amount);
  });

  it("should allow multiple collateral deposits", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    const amount1 = parseUnits("500", 6);
    const amount2 = parseUnits("300", 6);

    await perps.write.addCollateral([amount1], { account: buyer.account });
    await perps.write.addCollateral([amount2], { account: buyer.account });

    const balance = await perps.read.balanceOf([buyer.account.address]);
    assert.equal(balance, amount1 + amount2);
  });
});
