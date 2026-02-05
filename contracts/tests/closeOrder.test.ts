import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { parseUnits, zeroAddress, zeroHash } from "viem";
import { deployPerpsWithCollateralFixture, deployPerpsWithOrdersFixture } from "./fixtures";

describe("PerpsSimple - closeOrder", function () {
  it("should close an order successfully", async function () {
    const { contracts, accounts } = await loadFixture(deployPerpsWithOrdersFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    // Get buyer's orders
    const ordersBefore = await perps.read.getUserOrders([buyer.account.address]);
    expect(ordersBefore.length).to.be.greaterThan(0);

    const orderId = ordersBefore[0];

    // Close the order
    await perps.write.closeOrder([orderId], { account: buyer.account });

    // Verify order is removed
    const ordersAfter = await perps.read.getUserOrders([buyer.account.address]);
    expect(ordersAfter.length).to.equal(ordersBefore.length - 1);

    // Verify order no longer exists
    const order = await perps.read.getOrder([orderId]);
    expect(order.participant).to.equal(zeroAddress);
  });

  it("should revert when closing another user's order", async function () {
    const { contracts, accounts } = await loadFixture(deployPerpsWithOrdersFixture);
    const { perps } = contracts;
    const { buyer, seller } = accounts;

    // Get buyer's order
    const buyerOrders = await perps.read.getUserOrders([buyer.account.address]);
    expect(buyerOrders.length).to.be.greaterThan(0);

    const orderId = buyerOrders[0];

    // Seller tries to close buyer's order
    await expect(perps.write.closeOrder([orderId], { account: seller.account })).to.be.rejectedWith(
      "OrderNotBelongToSender"
    );
  });

  it("should revert when order does not exist", async function () {
    const { contracts, accounts } = await loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    const fakeOrderId = zeroHash;

    await expect(
      perps.write.closeOrder([fakeOrderId], { account: buyer.account })
    ).to.be.rejectedWith("OrderNotBelongToSender");
  });

  it("should update user total order value when closing order", async function () {
    const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    const marketPrice = await perps.read.getMarketPrice();
    const price = marketPrice - config.minimumPriceIncrement;
    const quantity = parseUnits("1", 6);

    // Create an order
    await perps.write.createOrder([price, BigInt(quantity)], {
      account: buyer.account,
    });

    const marginBefore = await perps.read.getRequiredMargin([buyer.account.address]);
    expect(marginBefore > 0n).to.be.true;

    // Close the order
    const orders = await perps.read.getUserOrders([buyer.account.address]);
    await perps.write.closeOrder([orders[0]], { account: buyer.account });

    // Required margin should decrease (only order fee margin if any position)
    const marginAfter = await perps.read.getRequiredMargin([buyer.account.address]);
    expect(marginAfter < marginBefore).to.be.true;
  });

  it("should remove order from price level tracking", async function () {
    const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { buyer } = accounts;

    const marketPrice = await perps.read.getMarketPrice();
    const price = marketPrice - config.minimumPriceIncrement;
    const quantity = parseUnits("1", 6);

    // Create an order
    await perps.write.createOrder([price, BigInt(quantity)], {
      account: buyer.account,
    });

    // Verify order appears in order book
    const [bidsBefore] = await perps.read.getOrderBookPrices([10n]);
    expect(bidsBefore).to.include(price);

    // Close the order
    const orders = await perps.read.getUserOrders([buyer.account.address]);
    await perps.write.closeOrder([orders[0]], { account: buyer.account });

    // Verify price level is removed from order book
    const [bidsAfter] = await perps.read.getOrderBookPrices([10n]);
    expect(bidsAfter).to.not.include(price);
  });
});
