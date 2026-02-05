import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { parseUnits, getAddress, zeroHash } from "viem";
import { deployPerpsWithCollateralFixture, deployPerpsWithOrdersFixture } from "./fixtures";

describe("PerpsSimple - getOrder", function () {
  it("should return order details", async function () {
    const { contracts, accounts, config } = await loadFixture(deployPerpsWithOrdersFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    const orders = await perps.read.getUserOrders([buyer.account.address]);
    expect(orders.length).to.be.greaterThan(0);

    const order = await perps.read.getOrder([orders[0]]);

    expect(getAddress(order.participant)).to.equal(getAddress(buyer.account.address));
    expect(order.price > 0n).to.be.true;
    expect(order.quantity > 0n).to.be.true; // Buy order
    expect(order.createdAt > 0n).to.be.true;
  });

  it("should return empty order for non-existent orderId", async function () {
    const { contracts } = await loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;

    const order = await perps.read.getOrder([zeroHash]);

    expect(order.participant).to.equal("0x0000000000000000000000000000000000000000");
    expect(order.price).to.equal(0n);
    expect(order.quantity).to.equal(0n);
  });

  it("should return correct quantity sign for buy orders", async function () {
    const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    const marketPrice = await perps.read.getMarketPrice();
    const price = marketPrice - config.minimumPriceIncrement;
    const quantity = parseUnits("1", 6);

    await perps.write.createOrder([price, BigInt(quantity)], {
      account: buyer.account,
    });

    const orders = await perps.read.getUserOrders([buyer.account.address]);
    const order = await perps.read.getOrder([orders[0]]);

    expect(order.quantity > 0n).to.be.true;
  });

  it("should return correct quantity sign for sell orders", async function () {
    const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { seller } = accounts;

    const marketPrice = await perps.read.getMarketPrice();
    const price = marketPrice + config.minimumPriceIncrement;
    const quantity = parseUnits("1", 6);

    await perps.write.createOrder([price, -BigInt(quantity)], {
      account: seller.account,
    });

    const orders = await perps.read.getUserOrders([seller.account.address]);
    const order = await perps.read.getOrder([orders[0]]);

    expect(order.quantity < 0n).to.be.true;
  });
});
