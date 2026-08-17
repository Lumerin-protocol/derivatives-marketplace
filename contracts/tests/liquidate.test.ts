import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { maxUint256, parseEventLogs } from "viem";
import {
  deployPerpsWithPositionsFixture,
  deployPerpsWithLiquidatablePositionFixture,
} from "./fixtures.ts";

const { viem, networkHelpers } = await network.connect();

describe("HashPowerPerpsDEX - liquidatePosition", function () {
  it("should revert when position is healthy", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithPositionsFixture);
    const { perps, pme } = contracts;
    const { seller, buyer2 } = accounts;

    const isLiquidatable = await pme.read.isLiquidatable([seller.account.address]);
    assert.ok(!isLiquidatable);

    await viem.assertions.revertWithCustomError(
      perps.write.liquidatePosition([seller.account.address, maxUint256], { account: buyer2.account }),
      perps,
      "NotLiquidatable",
    );
  });

  it("should liquidate underwater position successfully", async function () {
    const data = await networkHelpers.loadFixture(deployPerpsWithLiquidatablePositionFixture);
    const { contracts, accounts } = data;
    const { perps, pme } = contracts;
    const { seller, buyer2 } = accounts;

    const positionBefore = await perps.read.getUserPosition([seller.account.address]);
    assert.notEqual(positionBefore.netQuantity, 0n);

    await data.makeLiquidatable();

    const isLiquidatable = await pme.read.isLiquidatable([seller.account.address]);
    assert.ok(isLiquidatable);

    await perps.write.liquidatePosition([seller.account.address, maxUint256], { account: buyer2.account });

    const positionAfter = await perps.read.getUserPosition([seller.account.address]);
    assert.equal(positionAfter.netQuantity, 0n);
  });

  it("should pay liquidator fee", async function () {
    const data = await networkHelpers.loadFixture(deployPerpsWithLiquidatablePositionFixture);
    const { contracts, accounts } = data;
    const { perps, vault } = contracts;
    const { seller, buyer2 } = accounts;

    await data.makeLiquidatable();

    const liquidatorBalanceBefore = await vault.read.balanceOf([buyer2.account.address]);

    await perps.write.liquidatePosition([seller.account.address, maxUint256], { account: buyer2.account });

    const liquidatorBalanceAfter = await vault.read.balanceOf([buyer2.account.address]);

    assert.ok(liquidatorBalanceAfter >= liquidatorBalanceBefore);
  });

  it("should leave the liquidated position empty", async function () {
    const data = await networkHelpers.loadFixture(deployPerpsWithLiquidatablePositionFixture);
    const { contracts, accounts } = data;
    const { perps } = contracts;
    const { seller, buyer2 } = accounts;

    await data.makeLiquidatable();

    await perps.write.liquidatePosition([seller.account.address, maxUint256], { account: buyer2.account });

    assert.deepEqual(await perps.read.getUserPosition([seller.account.address]), {
      netQuantity: 0n,
      netEntryValue: 0n,
    });
  });

  it("should emit PositionLiquidated event", async function () {
    const data = await networkHelpers.loadFixture(deployPerpsWithLiquidatablePositionFixture);
    const { contracts, accounts } = data;
    const { perps } = contracts;
    const { seller, buyer2, pc } = accounts;

    await data.makeLiquidatable();

    const hash = await perps.write.liquidatePosition([seller.account.address, maxUint256], {
      account: buyer2.account,
    });
    const receipt = await pc.waitForTransactionReceipt({ hash });

    const events = parseEventLogs({ logs: receipt.logs, abi: perps.abi, eventName: "PositionLiquidated" });
    assert.equal(events.length, 1);
  });

  it("should revert when trying to liquidate non-existent position", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithPositionsFixture);
    const { perps } = contracts;
    const { buyer2 } = accounts;

    const position = await perps.read.getUserPosition([buyer2.account.address]);
    assert.equal(position.netQuantity, 0n);

    await viem.assertions.revertWithCustomError(
      perps.write.liquidatePosition([buyer2.account.address, maxUint256], { account: buyer2.account }),
      perps,
      "NotLiquidatable",
    );
  });
});
