import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits } from "viem";
import { deployPerpsWithCollateralFixture } from "./fixtures.ts";
import { TimeInForce } from "../fixtures/timeInForce.ts";

const { networkHelpers } = await network.getOrCreate();

describe("HashPowerPerpsDEX - Self-Trade Prevention", function () {
  it("partial self-cross: buy nets out own sell, no net position or fill", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { seller: userA, buyer: userB } = accounts;

    const price = await perps.read.getMarketPrice();
    const qty5 = parseUnits("5", config.quantityDecimals);
    const qty3 = parseUnits("3", config.quantityDecimals);
    const qty2 = parseUnits("2", config.quantityDecimals);

    await perps.write.createOrder([price, -qty5, TimeInForce.GTC], { account: userA.account });
    await perps.write.createOrder([price, -qty5, TimeInForce.GTC], { account: userB.account });
    await perps.write.createOrder([price, qty3, TimeInForce.GTC], { account: userA.account });

    const ordersA = await perps.read.getUserOrders([userA.account.address]);
    assert.equal(ordersA.length, 1);
    assert.equal((await perps.read.getOrder([ordersA[0]])).quantity, -qty2);

    const ordersB = await perps.read.getUserOrders([userB.account.address]);
    assert.equal(ordersB.length, 1);
    assert.equal((await perps.read.getOrder([ordersB[0]])).quantity, -qty5);

    assert.equal((await perps.read.getUserPosition([userA.account.address])).netQuantity, 0n);
    assert.equal((await perps.read.getUserPosition([userB.account.address])).netQuantity, 0n);
  });

  it("self-cross exhausts own sell, remaining buy matches B", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { seller: userA, buyer: userB } = accounts;

    const price = await perps.read.getMarketPrice();
    const qty5 = parseUnits("5", config.quantityDecimals);
    const qty8 = parseUnits("8", config.quantityDecimals);
    const qty3 = parseUnits("3", config.quantityDecimals);
    const qty2 = parseUnits("2", config.quantityDecimals);

    await perps.write.createOrder([price, -qty5, TimeInForce.GTC], { account: userA.account });
    await perps.write.createOrder([price, -qty5, TimeInForce.GTC], { account: userB.account });
    await perps.write.createOrder([price, qty8, TimeInForce.GTC], { account: userA.account });

    assert.equal((await perps.read.getUserOrders([userA.account.address])).length, 0);

    const ordersB = await perps.read.getUserOrders([userB.account.address]);
    assert.equal(ordersB.length, 1);
    assert.equal((await perps.read.getOrder([ordersB[0]])).quantity, -qty2);

    assert.equal((await perps.read.getUserPosition([userA.account.address])).netQuantity, qty3);
    assert.equal((await perps.read.getUserPosition([userB.account.address])).netQuantity, -qty3);
  });

  it("exact self-cross: sell and buy fully net out", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { seller: userA, buyer: userB } = accounts;

    const price = await perps.read.getMarketPrice();
    const qty5 = parseUnits("5", config.quantityDecimals);

    await perps.write.createOrder([price, -qty5, TimeInForce.GTC], { account: userA.account });
    await perps.write.createOrder([price, -qty5, TimeInForce.GTC], { account: userB.account });
    await perps.write.createOrder([price, qty5, TimeInForce.GTC], { account: userA.account });

    assert.equal((await perps.read.getUserOrders([userA.account.address])).length, 0);

    const ordersB = await perps.read.getUserOrders([userB.account.address]);
    assert.equal(ordersB.length, 1);
    assert.equal((await perps.read.getOrder([ordersB[0]])).quantity, -qty5);

    assert.equal((await perps.read.getUserPosition([userA.account.address])).netQuantity, 0n);
    assert.equal((await perps.read.getUserPosition([userB.account.address])).netQuantity, 0n);
  });

  it("multiple self-orders at same price: all consumed before matching B", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { seller: userA, buyer: userB } = accounts;

    const price = await perps.read.getMarketPrice();
    const qty2 = parseUnits("2", config.quantityDecimals);
    const qty5 = parseUnits("5", config.quantityDecimals);
    const qty7 = parseUnits("7", config.quantityDecimals);
    const qty3 = parseUnits("3", config.quantityDecimals);

    await perps.write.createOrder([price, -qty2, TimeInForce.GTC], { account: userA.account });
    await perps.write.createOrder([price, -qty2, TimeInForce.GTC], { account: userA.account });
    await perps.write.createOrder([price, -qty5, TimeInForce.GTC], { account: userB.account });

    assert.equal((await perps.read.getUserOrders([userA.account.address])).length, 2);
    assert.equal((await perps.read.getUserOrders([userB.account.address])).length, 1);

    await perps.write.createOrder([price, qty7, TimeInForce.GTC], { account: userA.account });

    assert.equal((await perps.read.getUserOrders([userA.account.address])).length, 0);

    const ordersB = await perps.read.getUserOrders([userB.account.address]);
    assert.equal(ordersB.length, 1);
    assert.equal((await perps.read.getOrder([ordersB[0]])).quantity, -qty2);

    assert.equal((await perps.read.getUserPosition([userA.account.address])).netQuantity, qty3);
    assert.equal((await perps.read.getUserPosition([userB.account.address])).netQuantity, -qty3);
  });

  it("cross-price: self-cross only at prices encountered during matching", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { seller: userA, buyer: userB } = accounts;

    const price = await perps.read.getMarketPrice();
    const tick = config.minimumPriceIncrement;
    const qty2 = parseUnits("2", config.quantityDecimals);
    const qty4 = parseUnits("4", config.quantityDecimals);
    const qty5 = parseUnits("5", config.quantityDecimals);
    const qty6 = parseUnits("6", config.quantityDecimals);
    const qty1 = parseUnits("1", config.quantityDecimals);

    await perps.write.createOrder([price, -qty2, TimeInForce.GTC], { account: userA.account });
    await perps.write.createOrder([price + tick, -qty2, TimeInForce.GTC], { account: userA.account });
    await perps.write.createOrder([price, -qty5, TimeInForce.GTC], { account: userB.account });

    await perps.write.createOrder([price + tick, qty6, TimeInForce.GTC], { account: userA.account });

    const ordersA = await perps.read.getUserOrders([userA.account.address]);
    assert.equal(ordersA.length, 1);
    assert.equal((await perps.read.getOrder([ordersA[0]])).quantity, -qty2);

    const ordersB = await perps.read.getUserOrders([userB.account.address]);
    assert.equal(ordersB.length, 1);
    assert.equal((await perps.read.getOrder([ordersB[0]])).quantity, -qty1);

    const posA = await perps.read.getUserPosition([userA.account.address]);
    const posB = await perps.read.getUserPosition([userB.account.address]);
    assert.equal(posA.netQuantity, qty4);
    assert.equal(posB.netQuantity, -qty4);
    assert.equal(posA.aggregatedEntryPrice, price);
  });

  it("matching bug: should correctly update quantity and perform matching correctly", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { seller: userA, buyer: userB } = accounts;

    const price = await perps.read.getMarketPrice();
    const tick = config.minimumPriceIncrement;
    const qty = parseUnits("1", config.quantityDecimals);

    await perps.write.createOrder([price + tick, 1n * qty, TimeInForce.GTC], { account: userB.account });
    await perps.write.createOrder([price, -2n * qty, TimeInForce.GTC], { account: userA.account });

    const positionA = await perps.read.getUserPosition([userA.account.address]);
    const positionB = await perps.read.getUserPosition([userB.account.address]);

    const ordersA = await perps.read.getUserOrders([userA.account.address]);
    const orderBook = await perps.read.getOrderBookPrices([10n]);
    const quantityAtPrice = await perps.read.getQuantityAtPrice([price, false]);

    assert.equal(positionA.netQuantity, -qty);
    assert.equal(positionB.netQuantity, qty);
    assert.equal(positionA.aggregatedEntryPrice, price + tick);
    assert.equal(positionB.aggregatedEntryPrice, price + tick);
    assert.equal(ordersA.length, 1);
    assert.equal(quantityAtPrice, qty);
    assert.equal(orderBook[1][0], price);
  });
});
