import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { deployPerpsWithCollateralFixture, deployPerpsWithPositionsFixture } from "./fixtures.ts";
import { TimeInForce } from "../fixtures/timeInForce.ts";
import {
  getAverageEntryPrice,
} from "./lib/viewHelpers.ts";

const { networkHelpers } = await network.getOrCreate();

describe("HashPowerPerpsDEX - getUserPosition", function () {
  it("should return zero position when user has no position", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    const position = await perps.read.getUserPosition([buyer.account.address]);
    assert.equal(position.netQuantity, 0n);
    assert.equal(position.netEntryValue, 0n);
    assert.equal(await getAverageEntryPrice(perps, buyer.account.address), 0n);
  });

  it("should return correct position for long", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithPositionsFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    const position = await perps.read.getUserPosition([buyer.account.address]);
    assert.ok(position.netQuantity > 0n);
    assert.equal(position.netEntryValue, config.marketPrice);
    assert.equal(await getAverageEntryPrice(perps, buyer.account.address), config.marketPrice);
  });

  it("should return correct position for short", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithPositionsFixture);
    const { perps } = contracts;
    const { seller } = accounts;

    const position = await perps.read.getUserPosition([seller.account.address]);
    assert.ok(position.netQuantity < 0n);
    assert.equal(position.netEntryValue, -config.marketPrice);
    assert.equal(await getAverageEntryPrice(perps, seller.account.address), config.marketPrice);
  });

  it("should update derived average entry price on adding to position", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithPositionsFixture);
    const { perps } = contracts;
    const { seller, buyer } = accounts;
    const tick = config.minimumPriceIncrement;

    const positionBefore = await perps.read.getUserPosition([buyer.account.address]);
    const averageBefore = await getAverageEntryPrice(perps, buyer.account.address);

    const newPrice = config.marketPrice + tick;

    await perps.write.createOrder([newPrice, -BigInt(config.qty), TimeInForce.GTC], { account: seller.account });
    await perps.write.createOrder([newPrice, BigInt(config.qty), TimeInForce.GTC], { account: buyer.account });

    const positionAfter = await perps.read.getUserPosition([buyer.account.address]);
    const averageAfter = await getAverageEntryPrice(perps, buyer.account.address);

    assert.ok(positionAfter.netQuantity > positionBefore.netQuantity);
    assert.ok(positionAfter.netEntryValue > positionBefore.netEntryValue);
    assert.ok(averageAfter > averageBefore);
    assert.ok(averageAfter < newPrice);
  });

  it("should return zero position after full close", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithPositionsFixture);
    const { perps } = contracts;
    const { seller, buyer } = accounts;

    await perps.write.createOrder([config.marketPrice, BigInt(config.qty), TimeInForce.GTC], { account: seller.account });
    await perps.write.createOrder([config.marketPrice, -BigInt(config.qty), TimeInForce.GTC], { account: buyer.account });

    const buyerPosition = await perps.read.getUserPosition([buyer.account.address]);
    assert.equal(buyerPosition.netQuantity, 0n);
    assert.equal(buyerPosition.netEntryValue, 0n, "closed position clears exact entry value");
    assert.equal(await getAverageEntryPrice(perps, buyer.account.address), 0n);
  });

  it("should overwrite entry price when new position opened after full close", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithPositionsFixture);
    const { perps } = contracts;
    const { seller, buyer } = accounts;
    const tick = config.minimumPriceIncrement;

    const entryBeforeClose = await getAverageEntryPrice(perps, buyer.account.address);
    assert.equal(entryBeforeClose, config.marketPrice);

    await perps.write.createOrder([config.marketPrice, BigInt(config.qty), TimeInForce.GTC], { account: seller.account });
    await perps.write.createOrder([config.marketPrice, -BigInt(config.qty), TimeInForce.GTC], { account: buyer.account });

    const afterClose = await perps.read.getUserPosition([buyer.account.address]);
    assert.equal(afterClose.netQuantity, 0n);
    assert.equal(afterClose.netEntryValue, 0n);

    const newPrice = config.marketPrice + tick;
    await perps.write.createOrder([newPrice, -BigInt(config.qty), TimeInForce.GTC], { account: seller.account });
    await perps.write.createOrder([newPrice, BigInt(config.qty), TimeInForce.GTC], { account: buyer.account });

    const afterReopen = await perps.read.getUserPosition([buyer.account.address]);
    assert.equal(afterReopen.netQuantity, BigInt(config.qty));
    assert.equal(await getAverageEntryPrice(perps, buyer.account.address), newPrice);
  });
});
