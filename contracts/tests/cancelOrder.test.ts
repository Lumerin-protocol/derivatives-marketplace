import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits, zeroAddress, zeroHash } from "viem";
import { deployPerpsWithCollateralFixture, deployPerpsWithOrdersFixture } from "./fixtures.ts";
import { TimeInForce } from "../fixtures/timeInForce.ts";

const { viem, networkHelpers } = await network.connect();

describe("HashPowerPerpsDEX - cancelOrder", function () {
  it("should close an order successfully", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithOrdersFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    const ordersBefore = await perps.read.getUserOrders([buyer.account.address]);
    assert.ok(ordersBefore.length > 0);

    const orderId = ordersBefore[0];

    await perps.write.cancelOrder([orderId], { account: buyer.account });

    const ordersAfter = await perps.read.getUserOrders([buyer.account.address]);
    assert.equal(ordersAfter.length, ordersBefore.length - 1);

    const order = await perps.read.getOrder([orderId]);
    assert.equal(order.participant, zeroAddress);
  });

  it("should revert when closing another user's order", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithOrdersFixture);
    const { perps } = contracts;
    const { buyer, seller } = accounts;

    const buyerOrders = await perps.read.getUserOrders([buyer.account.address]);
    assert.ok(buyerOrders.length > 0);

    const orderId = buyerOrders[0];

    await viem.assertions.revertWithCustomError(
      perps.write.cancelOrder([orderId], { account: seller.account }),
      perps,
      "OrderNotBelongToSender",
    );
  });

  it("should revert when order does not exist", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    await viem.assertions.revertWithCustomError(
      perps.write.cancelOrder([zeroHash], { account: buyer.account }),
      perps,
      "OrderNotBelongToSender",
    );
  });

  it("should update user total order value when closing order", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    const marketPrice = await perps.read.getMarketPrice();
    const price = marketPrice - config.minimumPriceIncrement;
    const quantity = parseUnits("1", 6);

    await perps.write.createOrder([price, BigInt(quantity), TimeInForce.GTC], { account: buyer.account });

    const [, , buyValueBefore] = await perps.read.getOrderAggregate([buyer.account.address]);
    assert.ok(buyValueBefore > 0n);
    assert.ok((await perps.read.getRiskView([buyer.account.address])).buyOrderDelta > 0n);

    const orders = await perps.read.getUserOrders([buyer.account.address]);
    await perps.write.cancelOrder([orders[0]], { account: buyer.account });

    const [, , buyValueAfter] = await perps.read.getOrderAggregate([buyer.account.address]);
    assert.equal(buyValueAfter, 0n);
    assert.equal((await perps.read.getRiskView([buyer.account.address])).buyOrderDelta, 0n);
  });

  it("should remove order from price level tracking", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    const marketPrice = await perps.read.getMarketPrice();
    const price = marketPrice - config.minimumPriceIncrement;
    const quantity = parseUnits("1", 6);

    await perps.write.createOrder([price, BigInt(quantity), TimeInForce.GTC], { account: buyer.account });

    const [bidsBefore] = await perps.read.getOrderBookPrices([10n]);
    assert.ok(bidsBefore.includes(price));

    const orders = await perps.read.getUserOrders([buyer.account.address]);
    await perps.write.cancelOrder([orders[0]], { account: buyer.account });

    const [bidsAfter] = await perps.read.getOrderBookPrices([10n]);
    assert.ok(!bidsAfter.includes(price));
  });
});
