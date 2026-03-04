import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits, getAddress } from "viem";
import { deployPerpsWithCollateralFixture, deployPerpsWithPositionsFixture } from "./fixtures.ts";

const { viem, networkHelpers } = await network.connect();

describe("PerpsSimple - getUserPosition", function () {
  it("should return zero position when user has no position", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    const position = await perps.read.getUserPosition([buyer.account.address]);
    assert.equal(position.netQuantity, 0n);
    assert.equal(position.aggregatedEntryPrice, 0n);
  });

  it("should return correct position for long", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithPositionsFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    const position = await perps.read.getUserPosition([buyer.account.address]);
    assert.ok(position.netQuantity > 0n);
    assert.equal(position.aggregatedEntryPrice, config.marketPrice);
  });

  it("should return correct position for short", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithPositionsFixture);
    const { perps } = contracts;
    const { seller } = accounts;

    const position = await perps.read.getUserPosition([seller.account.address]);
    assert.ok(position.netQuantity < 0n);
    assert.equal(position.aggregatedEntryPrice, config.marketPrice);
  });

  it("should update aggregated entry price on adding to position", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithPositionsFixture);
    const { perps } = contracts;
    const { seller, buyer } = accounts;
    const tick = config.minimumPriceIncrement;

    const positionBefore = await perps.read.getUserPosition([buyer.account.address]);

    const newPrice = config.marketPrice + tick;

    await perps.write.createOrder([newPrice, -BigInt(config.qty)], { account: seller.account });
    await perps.write.createOrder([newPrice, BigInt(config.qty)], { account: buyer.account });

    const positionAfter = await perps.read.getUserPosition([buyer.account.address]);

    assert.ok(positionAfter.netQuantity > positionBefore.netQuantity);
    assert.ok(positionAfter.aggregatedEntryPrice > positionBefore.aggregatedEntryPrice);
    assert.ok(positionAfter.aggregatedEntryPrice < newPrice);
  });

  it("should return zero position after full close", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithPositionsFixture);
    const { perps } = contracts;
    const { seller, buyer } = accounts;

    await perps.write.createOrder([config.marketPrice, BigInt(config.qty)], { account: seller.account });
    await perps.write.createOrder([config.marketPrice, -BigInt(config.qty)], { account: buyer.account });

    const buyerPosition = await perps.read.getUserPosition([buyer.account.address]);
    assert.equal(buyerPosition.netQuantity, 0n);
  });
});
