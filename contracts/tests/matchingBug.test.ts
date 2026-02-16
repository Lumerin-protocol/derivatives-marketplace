import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { parseUnits } from "viem";
import { deployPerpsWithCollateralFixture } from "./fixtures";

/**
 * Tests for self-trade behavior after removing _offsetUserOppositeOrders.
 *
 * Self-trades are now allowed: if a user's incoming order matches their own
 * resting order, it executes normally via _executeMatch. The position updates
 * cancel out (buyer == seller), so the net position effect is zero, but fees
 * are charged on both sides. Users who want to avoid self-trading can
 * cancelOrder() their resting orders beforehand.
 */
describe("PerpsSimple - Self-Trade Behavior", function () {
  it("partial self-trade: buy partially fills own sell, no net position", async function () {
    // A sells 5, B sells 5. A buys 3. A's buy matches A's sell (FIFO head).
    // Self-trade: position +3 then -3 = 0. A's sell reduced to 2. B untouched.
    const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { seller: userA, buyer: userB } = accounts;

    const price = await perps.read.getMarketPrice();
    const qty5 = parseUnits("5", config.quantityDecimals);
    const qty3 = parseUnits("3", config.quantityDecimals);
    const qty2 = parseUnits("2", config.quantityDecimals);

    await perps.write.createOrder([price, -qty5], { account: userA.account }); // A: sell 5
    await perps.write.createOrder([price, -qty5], { account: userB.account }); // B: sell 5
    await perps.write.createOrder([price, qty3], { account: userA.account }); // A: buy 3

    // A's sell reduced from 5 to 2 (partial fill via self-trade)
    const ordersA = await perps.read.getUserOrders([userA.account.address]);
    expect(ordersA.length).to.equal(1);
    expect((await perps.read.getOrder([ordersA[0]])).quantity).to.equal(-qty2);

    // B's sell untouched (A's buy was fully consumed by self-trade)
    const ordersB = await perps.read.getUserOrders([userB.account.address]);
    expect(ordersB.length).to.equal(1);
    expect((await perps.read.getOrder([ordersB[0]])).quantity).to.equal(-qty5);

    // No net position for either (self-trade nets to zero)
    expect((await perps.read.getUserPosition([userA.account.address])).netQuantity).to.equal(0n);
    expect((await perps.read.getUserPosition([userB.account.address])).netQuantity).to.equal(0n);
  });

  it("self-trade exhausts own sell, remaining buy matches B", async function () {
    // A sells 5, B sells 5. A buys 8.
    // Self-trade: fills A's sell(5) → nets to zero. Remaining 3 matches B.
    // Result: A long 3, B short 3.
    const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { seller: userA, buyer: userB } = accounts;

    const price = await perps.read.getMarketPrice();
    const qty5 = parseUnits("5", config.quantityDecimals);
    const qty8 = parseUnits("8", config.quantityDecimals);
    const qty3 = parseUnits("3", config.quantityDecimals);
    const qty2 = parseUnits("2", config.quantityDecimals);

    await perps.write.createOrder([price, -qty5], { account: userA.account }); // A: sell 5
    await perps.write.createOrder([price, -qty5], { account: userB.account }); // B: sell 5
    await perps.write.createOrder([price, qty8], { account: userA.account }); // A: buy 8

    // A: sell consumed by self-trade, no resting orders
    expect((await perps.read.getUserOrders([userA.account.address])).length).to.equal(0);

    // B: sell reduced from 5 to 2 (matched 3 with A's remaining buy)
    const ordersB = await perps.read.getUserOrders([userB.account.address]);
    expect(ordersB.length).to.equal(1);
    expect((await perps.read.getOrder([ordersB[0]])).quantity).to.equal(-qty2);

    // Positions: A long 3, B short 3 (from the match after self-trade)
    expect((await perps.read.getUserPosition([userA.account.address])).netQuantity).to.equal(qty3);
    expect((await perps.read.getUserPosition([userB.account.address])).netQuantity).to.equal(-qty3);
  });

  it("exact self-trade: sell fully consumed, buy fully consumed", async function () {
    // A sells 5, B sells 5. A buys 5. Self-trade fills all 5.
    // No remaining quantity → no matching with B.
    const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { seller: userA, buyer: userB } = accounts;

    const price = await perps.read.getMarketPrice();
    const qty5 = parseUnits("5", config.quantityDecimals);

    await perps.write.createOrder([price, -qty5], { account: userA.account }); // A: sell 5
    await perps.write.createOrder([price, -qty5], { account: userB.account }); // B: sell 5
    await perps.write.createOrder([price, qty5], { account: userA.account }); // A: buy 5

    // A: sell consumed by self-trade, no resting orders
    expect((await perps.read.getUserOrders([userA.account.address])).length).to.equal(0);

    // B: sell untouched
    const ordersB = await perps.read.getUserOrders([userB.account.address]);
    expect(ordersB.length).to.equal(1);
    expect((await perps.read.getOrder([ordersB[0]])).quantity).to.equal(-qty5);

    // No net positions
    expect((await perps.read.getUserPosition([userA.account.address])).netQuantity).to.equal(0n);
    expect((await perps.read.getUserPosition([userB.account.address])).netQuantity).to.equal(0n);
  });

  it("multiple self-orders at same price: all consumed before matching B", async function () {
    // A has two sells at P, B has one sell at P. A places large buy.
    // FIFO: A's sells are at the head. Both consumed by self-trade, then B matched.
    const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { seller: userA, buyer: userB } = accounts;

    const price = await perps.read.getMarketPrice();
    const qty2 = parseUnits("2", config.quantityDecimals);
    const qty5 = parseUnits("5", config.quantityDecimals);
    const qty7 = parseUnits("7", config.quantityDecimals);
    const qty3 = parseUnits("3", config.quantityDecimals);

    await perps.write.createOrder([price, -qty2], { account: userA.account }); // A: sell 2
    await perps.write.createOrder([price, -qty2], { account: userA.account }); // A: sell 2
    await perps.write.createOrder([price, -qty5], { account: userB.account }); // B: sell 5

    // shortQueue[P] = [A₁(2), A₂(2), B(5)]
    expect((await perps.read.getUserOrders([userA.account.address])).length).to.equal(2);
    expect((await perps.read.getUserOrders([userB.account.address])).length).to.equal(1);

    // A places BUY 7: self-trade consumes A₁(2) + A₂(2) = 4, remaining 3 matches B
    await perps.write.createOrder([price, qty7], { account: userA.account });

    // A: both sells consumed, no resting orders
    expect((await perps.read.getUserOrders([userA.account.address])).length).to.equal(0);

    // B: sell reduced from 5 to 2
    const ordersB = await perps.read.getUserOrders([userB.account.address]);
    expect(ordersB.length).to.equal(1);
    expect((await perps.read.getOrder([ordersB[0]])).quantity).to.equal(-qty2);

    // Positions: A long 3 (from B match, self-trade portion nets to zero), B short 3
    expect((await perps.read.getUserPosition([userA.account.address])).netQuantity).to.equal(qty3);
    expect((await perps.read.getUserPosition([userB.account.address])).netQuantity).to.equal(-qty3);
  });

  it("cross-price: self-trade only at prices encountered during matching", async function () {
    // A sells 2@P, A sells 2@P+1, B sells 5@P. A buys 6@P+1.
    // Matching walks asks low→high: at P, queue=[A(2),B(5)].
    // Self-trade A(2)@P → nets zero, remaining=4. Match B(5)@P → fill 4, remaining=0.
    // A's sell@P+1 is never reached → survives on the book.
    // (This differs from old offset which pre-scanned ALL of A's orders.)
    const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { seller: userA, buyer: userB } = accounts;

    const price = await perps.read.getMarketPrice();
    const tick = config.minimumPriceIncrement;
    const qty2 = parseUnits("2", config.quantityDecimals);
    const qty4 = parseUnits("4", config.quantityDecimals);
    const qty5 = parseUnits("5", config.quantityDecimals);
    const qty6 = parseUnits("6", config.quantityDecimals);
    const qty1 = parseUnits("1", config.quantityDecimals);

    await perps.write.createOrder([price, -qty2], { account: userA.account }); // A: sell 2 @ P
    await perps.write.createOrder([price + tick, -qty2], { account: userA.account }); // A: sell 2 @ P+1
    await perps.write.createOrder([price, -qty5], { account: userB.account }); // B: sell 5 @ P

    // A places BUY 6 at P+tick
    // At price P: self-trade A(2), match B(4). Buy fully consumed. Never reaches P+1.
    await perps.write.createOrder([price + tick, qty6], { account: userA.account });

    // A: sell@P consumed, but sell@P+1 survives (matching didn't reach it)
    const ordersA = await perps.read.getUserOrders([userA.account.address]);
    expect(ordersA.length).to.equal(1);
    expect((await perps.read.getOrder([ordersA[0]])).quantity).to.equal(-qty2); // sell 2 @ P+1

    // B: sell reduced from 5 to 1 (matched 4 with A's remaining buy)
    const ordersB = await perps.read.getUserOrders([userB.account.address]);
    expect(ordersB.length).to.equal(1);
    expect((await perps.read.getOrder([ordersB[0]])).quantity).to.equal(-qty1);

    // Positions: A long 4 (from B match), B short 4
    const posA = await perps.read.getUserPosition([userA.account.address]);
    const posB = await perps.read.getUserPosition([userB.account.address]);
    expect(posA.netQuantity).to.equal(qty4);
    expect(posB.netQuantity).to.equal(-qty4);
    expect(posA.aggregatedEntryPrice).to.equal(price); // executed at maker's price (B's ask = P)
  });

  it("matching bug: should correctly update quantity and perform matching correctly", async function () {
    const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { seller: userA, buyer: userB } = accounts;

    const price = await perps.read.getMarketPrice();
    const tick = config.minimumPriceIncrement;
    const qty = parseUnits("1", config.quantityDecimals);

    await perps.write.createOrder([price + tick, 1n * qty], { account: userB.account });
    await perps.write.createOrder([price, -2n * qty], { account: userA.account });

    const positionA = await perps.read.getUserPosition([userA.account.address]);
    const positionB = await perps.read.getUserPosition([userB.account.address]);

    const ordersA = await perps.read.getUserOrders([userA.account.address]);
    const orderBook = await perps.read.getOrderBookPrices([10n]);
    const quantityAtPrice = await perps.read.getQuantityAtPrice([price, false]);

    expect(positionA.netQuantity).to.equal(-qty);
    expect(positionB.netQuantity).to.equal(qty);
    expect(positionA.aggregatedEntryPrice).to.equal(price + tick);
    expect(positionB.aggregatedEntryPrice).to.equal(price + tick);
    expect(ordersA.length).to.equal(1);
    expect(quantityAtPrice).to.equal(qty);
    expect(orderBook[1][0]).to.equal(price);
  });
});
