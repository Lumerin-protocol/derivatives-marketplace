import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { getAddress, parseEventLogs, parseUnits } from "viem";
import { deployPerpsFixture } from "./fixtures";

describe("PerpsSimple - addCollateral", function () {
  it("should add collateral successfully", async function () {
    const { contracts, accounts } = await loadFixture(deployPerpsFixture);
    const { perps, usdcMock } = contracts;
    const { buyer } = accounts;

    const amount = parseUnits("1000", 6);

    // Check balances before
    const usdcBalanceBefore = await usdcMock.read.balanceOf([buyer.account.address]);
    const perpsBalanceBefore = await perps.read.balanceOf([buyer.account.address]);

    // Add collateral
    await perps.write.addCollateral([amount], { account: buyer.account });

    // Check balances after
    const usdcBalanceAfter = await usdcMock.read.balanceOf([buyer.account.address]);
    const perpsBalanceAfter = await perps.read.balanceOf([buyer.account.address]);

    expect(usdcBalanceBefore - usdcBalanceAfter).to.equal(amount);
    expect(perpsBalanceAfter - perpsBalanceBefore).to.equal(amount);
  });

  it("should revert on zero amount", async function () {
    const { contracts, accounts } = await loadFixture(deployPerpsFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    await expect(perps.write.addCollateral([0n], { account: buyer.account })).to.be.rejectedWith(
      "InvalidSize"
    );
  });

  it("should emit CollateralAdded event", async function () {
    const { contracts, accounts } = await loadFixture(deployPerpsFixture);
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

    expect(collateralAddedEvent).to.exist;
    expect(collateralAddedEvent.args.user).to.equal(getAddress(buyer.account.address));
    expect(collateralAddedEvent.args.amount).to.equal(amount);
  });

  it("should transfer tokens from user to contract", async function () {
    const { contracts, accounts } = await loadFixture(deployPerpsFixture);
    const { perps, usdcMock } = contracts;
    const { buyer } = accounts;

    const amount = parseUnits("500", 6);

    const contractBalanceBefore = await usdcMock.read.balanceOf([perps.address]);

    await perps.write.addCollateral([amount], { account: buyer.account });

    const contractBalanceAfter = await usdcMock.read.balanceOf([perps.address]);
    expect(contractBalanceAfter - contractBalanceBefore).to.equal(amount);
  });

  it("should allow multiple collateral deposits", async function () {
    const { contracts, accounts } = await loadFixture(deployPerpsFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    const amount1 = parseUnits("500", 6);
    const amount2 = parseUnits("300", 6);

    await perps.write.addCollateral([amount1], { account: buyer.account });
    await perps.write.addCollateral([amount2], { account: buyer.account });

    const balance = await perps.read.balanceOf([buyer.account.address]);
    expect(balance).to.equal(amount1 + amount2);
  });
});
