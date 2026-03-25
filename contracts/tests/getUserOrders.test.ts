import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits } from "viem";
import { deployPerpsWithCollateralFixture, deployPerpsWithOrdersFixture } from "./fixtures.ts";

const { viem, networkHelpers } = await network.connect();

describe("HashPowerPerpsDEX - getUserOrders", function () {
  it("should return empty array when user has no orders", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    const orders = await perps.read.getUserOrders([buyer.account.address]);
    assert.equal(orders.length, 0);
  });

  it("should return all user orders", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithOrdersFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    const orders = await perps.read.getUserOrders([buyer.account.address]);
    assert.equal(orders.length, 3);
  });

  it("should update after order is closed", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithOrdersFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    const ordersBefore = await perps.read.getUserOrders([buyer.account.address]);
    const initialCount = ordersBefore.length;

    await perps.write.cancelOrder([ordersBefore[0]], { account: buyer.account });

    const ordersAfter = await perps.read.getUserOrders([buyer.account.address]);
    assert.equal(ordersAfter.length, initialCount - 1);
  });

  it("should update after order is matched", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithOrdersFixture);
    const { perps } = contracts;
    const { seller, buyer2 } = accounts;
    const { marketPrice, qty } = config;
    const tick = config.minimumPriceIncrement;

    const sellerOrdersBefore = await perps.read.getUserOrders([seller.account.address]);
    assert.equal(sellerOrdersBefore.length, 3);

    await perps.write.createOrder([marketPrice + tick, BigInt(qty)], { account: buyer2.account });

    const sellerOrdersAfter = await perps.read.getUserOrders([seller.account.address]);
    assert.equal(sellerOrdersAfter.length, 2);
  });

  it("should contain valid order IDs", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithOrdersFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    const orderIds = await perps.read.getUserOrders([buyer.account.address]);

    for (const orderId of orderIds) {
      const order = await perps.read.getOrder([orderId]);
      assert.notEqual(order.participant, "0x0000000000000000000000000000000000000000");
      assert.ok(order.price > 0n);
    }
  });
});
