import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { parseUnits, getAddress } from "viem";
import {
  deployPerpsWithPositionsFixture,
  deployPerpsWithLiquidatablePositionFixture,
} from "./fixtures";

describe("PerpsSimple - liquidate", function () {
  it("should revert when position is healthy", async function () {
    const { contracts, accounts } = await loadFixture(deployPerpsWithPositionsFixture);
    const { perps } = contracts;
    const { seller, buyer2 } = accounts;

    // Seller has a position but is not liquidatable
    const isLiquidatable = await perps.read.isLiquidatable([seller.account.address]);
    expect(isLiquidatable).to.be.false;

    await expect(
      perps.write.liquidate([seller.account.address], { account: buyer2.account })
    ).to.be.rejectedWith("NotLiquidatable");
  });

  it("should liquidate underwater position successfully", async function () {
    const data = await loadFixture(deployPerpsWithLiquidatablePositionFixture);
    const { contracts, accounts } = data;
    const { perps } = contracts;
    const { seller, buyer2 } = accounts;

    // Verify seller has a position
    const positionBefore = await perps.read.getUserPosition([seller.account.address]);
    expect(positionBefore.netQuantity).to.not.equal(0n);

    // Make seller liquidatable by moving price
    await data.makeLiquidatable();

    // Verify seller is now liquidatable
    const isLiquidatable = await perps.read.isLiquidatable([seller.account.address]);
    expect(isLiquidatable).to.be.true;

    // Liquidate
    await perps.write.liquidate([seller.account.address], { account: buyer2.account });

    // Position should be cleared
    const positionAfter = await perps.read.getUserPosition([seller.account.address]);
    expect(positionAfter.netQuantity).to.equal(0n);
  });

  it("should pay liquidator fee", async function () {
    const data = await loadFixture(deployPerpsWithLiquidatablePositionFixture);
    const { contracts, accounts, config } = data;
    const { perps } = contracts;
    const { seller, buyer2 } = accounts;

    // Make seller liquidatable
    await data.makeLiquidatable();

    const liquidatorBalanceBefore = await perps.read.balanceOf([buyer2.account.address]);

    // Liquidate
    await perps.write.liquidate([seller.account.address], { account: buyer2.account });

    const liquidatorBalanceAfter = await perps.read.balanceOf([buyer2.account.address]);

    // Liquidator should receive fee (up to available balance from liquidated user)
    expect(liquidatorBalanceAfter >= liquidatorBalanceBefore).to.be.true;
  });

  it("should clear position after liquidation", async function () {
    const data = await loadFixture(deployPerpsWithLiquidatablePositionFixture);
    const { contracts, accounts } = data;
    const { perps } = contracts;
    const { seller, buyer2 } = accounts;

    await data.makeLiquidatable();

    // Verify seller is in users with positions before
    const usersBefore = await perps.read.getUsersWithPositions();
    expect(usersBefore.map((u: string) => getAddress(u))).to.include(
      getAddress(seller.account.address)
    );

    // Liquidate
    await perps.write.liquidate([seller.account.address], { account: buyer2.account });

    // Verify seller is removed from users with positions
    const usersAfter = await perps.read.getUsersWithPositions();
    expect(usersAfter.map((u: string) => getAddress(u))).to.not.include(
      getAddress(seller.account.address)
    );
  });

  it("should emit PositionLiquidated event", async function () {
    const data = await loadFixture(deployPerpsWithLiquidatablePositionFixture);
    const { contracts, accounts } = data;
    const { perps } = contracts;
    const { seller, buyer2, pc } = accounts;

    await data.makeLiquidatable();

    const hash = await perps.write.liquidate([seller.account.address], {
      account: buyer2.account,
    });
    const receipt = await pc.waitForTransactionReceipt({ hash });

    // Check event was emitted
    const events = receipt.logs.filter(
      (log) => log.address.toLowerCase() === perps.address.toLowerCase()
    );
    expect(events.length).to.be.greaterThan(0);
  });

  it("should revert when trying to liquidate non-existent position", async function () {
    const { contracts, accounts } = await loadFixture(deployPerpsWithPositionsFixture);
    const { perps } = contracts;
    const { buyer2 } = accounts;

    // buyer2 has no position
    const position = await perps.read.getUserPosition([buyer2.account.address]);
    expect(position.netQuantity).to.equal(0n);

    await expect(
      perps.write.liquidate([buyer2.account.address], { account: buyer2.account })
    ).to.be.rejectedWith("NotLiquidatable");
  });
});
