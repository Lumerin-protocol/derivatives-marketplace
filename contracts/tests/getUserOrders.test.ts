import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { parseUnits } from "viem";
import { deployPerpsWithCollateralFixture, deployPerpsWithOrdersFixture } from "./fixtures";

describe("PerpsSimple - getUserOrders", function () {
  it("should return empty array when user has no orders", async function () {
    const { contracts, accounts } = await loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    const orders = await perps.read.getUserOrders([buyer.account.address]);
    expect(orders.length).to.equal(0);
  });

  it("should return all user orders", async function () {
    const { contracts, accounts, config } = await loadFixture(deployPerpsWithOrdersFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    // Buyer has 3 orders from the fixture
    const orders = await perps.read.getUserOrders([buyer.account.address]);
    expect(orders.length).to.equal(3);
  });

  it("should update after order is closed", async function () {
    const { contracts, accounts } = await loadFixture(deployPerpsWithOrdersFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    const ordersBefore = await perps.read.getUserOrders([buyer.account.address]);
    const initialCount = ordersBefore.length;

    // Close one order
    await perps.write.closeOrder([ordersBefore[0]], { account: buyer.account });

    const ordersAfter = await perps.read.getUserOrders([buyer.account.address]);
    expect(ordersAfter.length).to.equal(initialCount - 1);
  });

  it("should update after order is matched", async function () {
    const { contracts, accounts, config } = await loadFixture(deployPerpsWithOrdersFixture);
    const { perps } = contracts;
    const { seller, buyer2 } = accounts;
    const { marketPrice, qty } = config;
    const tick = config.minimumPriceIncrement;

    // Seller has 3 orders
    const sellerOrdersBefore = await perps.read.getUserOrders([seller.account.address]);
    expect(sellerOrdersBefore.length).to.equal(3);

    // Buyer2 places a buy order that matches seller's best ask
    await perps.write.createOrder([marketPrice + tick, BigInt(qty)], {
      account: buyer2.account,
    });

    // Seller should have one less order
    const sellerOrdersAfter = await perps.read.getUserOrders([seller.account.address]);
    expect(sellerOrdersAfter.length).to.equal(2);
  });

  it("should contain valid order IDs", async function () {
    const { contracts, accounts } = await loadFixture(deployPerpsWithOrdersFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    const orderIds = await perps.read.getUserOrders([buyer.account.address]);

    for (const orderId of orderIds) {
      const order = await perps.read.getOrder([orderId]);
      expect(order.participant).to.not.equal("0x0000000000000000000000000000000000000000");
      expect(order.price > 0n).to.be.true;
    }
  });
});
