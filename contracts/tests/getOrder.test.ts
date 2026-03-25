import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits, getAddress, zeroHash } from "viem";
import { deployPerpsWithCollateralFixture, deployPerpsWithOrdersFixture } from "./fixtures.ts";

const { viem, networkHelpers } = await network.connect();

describe("HashPowerPerpsDEX - getOrder", function () {
  it("should return order details", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithOrdersFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    const orders = await perps.read.getUserOrders([buyer.account.address]);
    assert.ok(orders.length > 0);

    const order = await perps.read.getOrder([orders[0]]);

    assert.equal(getAddress(order.participant), getAddress(buyer.account.address));
    assert.ok(order.price > 0n);
    assert.ok(order.quantity > 0n);
  });

  it("should return empty order for non-existent orderId", async function () {
    const { contracts } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;

    const order = await perps.read.getOrder([zeroHash]);

    assert.equal(order.participant, "0x0000000000000000000000000000000000000000");
    assert.equal(order.price, 0n);
    assert.equal(order.quantity, 0n);
  });

  it("should return correct quantity sign for buy orders", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    const marketPrice = await perps.read.getMarketPrice();
    const price = marketPrice - config.minimumPriceIncrement;
    const quantity = parseUnits("1", 6);

    await perps.write.createOrder([price, BigInt(quantity)], { account: buyer.account });

    const orders = await perps.read.getUserOrders([buyer.account.address]);
    const order = await perps.read.getOrder([orders[0]]);

    assert.ok(order.quantity > 0n);
  });

  it("should return correct quantity sign for sell orders", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { seller } = accounts;

    const marketPrice = await perps.read.getMarketPrice();
    const price = marketPrice + config.minimumPriceIncrement;
    const quantity = parseUnits("1", 6);

    await perps.write.createOrder([price, -BigInt(quantity)], { account: seller.account });

    const orders = await perps.read.getUserOrders([seller.account.address]);
    const order = await perps.read.getOrder([orders[0]]);

    assert.ok(order.quantity < 0n);
  });
});
