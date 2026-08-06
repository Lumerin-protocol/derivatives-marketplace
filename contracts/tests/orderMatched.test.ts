import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits, getAddress, parseEventLogs } from "viem";
import {
  deployPerpsWithCollateralFixture,
  deployPerpsWithOrdersFixture,
} from "./fixtures.ts";
import { TimeInForce } from "../fixtures/timeInForce.ts";

const { networkHelpers } = await network.connect();

describe("HashPowerPerpsDEX - OrderMatched event", function () {
  it("emits correct maker, taker, price, quantity for a full match", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { seller, buyer, pc } = accounts;
    const marketPrice = await perps.read.getMarketPrice();
    const qty = parseUnits("1", config.quantityDecimals);

    await perps.write.createOrder([marketPrice, -qty, TimeInForce.GTC], { account: seller.account });

    const hash = await perps.write.createOrder([marketPrice, qty, TimeInForce.GTC], { account: buyer.account });
    const receipt = await pc.waitForTransactionReceipt({ hash });

    const matched = parseEventLogs({ logs: receipt.logs, abi: perps.abi, eventName: "OrderMatched" });
    assert.equal(matched.length, 1, "exactly one OrderMatched event");

    const e = matched[0].args;
    assert.equal(e.maker, getAddress(seller.account.address), "maker is the resting order owner");
    assert.equal(e.taker, getAddress(buyer.account.address), "taker is the incoming order owner");
    assert.equal(e.tradePrice, marketPrice);
    assert.equal(e.takerQuantity, qty, "taker is buying, so takerQuantity is positive");
  });

  it("emits makerFee and takerFee with correct values", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { seller, buyer, pc } = accounts;
    const marketPrice = await perps.read.getMarketPrice();
    const qty = parseUnits("1", config.quantityDecimals);

    await perps.write.createOrder([marketPrice, -qty, TimeInForce.GTC], { account: seller.account });

    const hash = await perps.write.createOrder([marketPrice, qty, TimeInForce.GTC], { account: buyer.account });
    const receipt = await pc.waitForTransactionReceipt({ hash });

    const [{ args }] = parseEventLogs({
      logs: receipt.logs,
      abi: perps.abi,
      eventName: "OrderMatched",
    });

    const notional = (marketPrice * qty) / 10n ** BigInt(config.quantityDecimals);
    const expectedTakerFee = (notional * config.takerFeeBps) / 10000n;
    const expectedMakerFee = (notional * config.makerFeeBps) / 10000n;

    assert.equal(args.takerFee, expectedTakerFee, "takerFee should match bps calculation");
    assert.equal(args.makerFee, expectedMakerFee, "makerFee should match bps calculation");
  });

  it("emits makerFee=0 when makerFeeBps is 0", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { seller, buyer, pc } = accounts;
    const marketPrice = await perps.read.getMarketPrice();
    const qty = parseUnits("1", config.quantityDecimals);

    await perps.write.createOrder([marketPrice, -qty, TimeInForce.GTC], { account: seller.account });

    const hash = await perps.write.createOrder([marketPrice, qty, TimeInForce.GTC], { account: buyer.account });
    const receipt = await pc.waitForTransactionReceipt({ hash });

    const [{ args }] = parseEventLogs({
      logs: receipt.logs,
      abi: perps.abi,
      eventName: "OrderMatched",
    });

    assert.equal(args.makerFee, 0n, "makerFee should be 0 when makerFeeBps=0");
  });

  it("emits multiple OrderMatched events for partial fills across price levels", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithOrdersFixture,
    );
    const { perps } = contracts;
    const { buyer2, pc } = accounts;
    const { marketPrice, qty } = config;
    const tick = config.minimumPriceIncrement;

    // buyer2 sweeps 3 sell levels → 3 OrderMatched events
    const sweepPrice = marketPrice + 4n * tick;
    const sweepQty = qty * 3n;

    const hash = await perps.write.createOrder([sweepPrice, sweepQty, TimeInForce.GTC], {
      account: buyer2.account,
    });
    const receipt = await pc.waitForTransactionReceipt({ hash });

    const matched = parseEventLogs({
      logs: receipt.logs,
      abi: perps.abi,
      eventName: "OrderMatched",
    });

    assert.equal(matched.length, 3, "three OrderMatched events for three price levels");

    // All events should have buyer2 as taker
    for (const e of matched) {
      assert.equal(e.args.taker, getAddress(buyer2.account.address));
      assert.equal(e.args.takerQuantity, qty, "each level has 1 unit (taker is buying)");
    }

    // Prices should be ascending (best ask first)
    const prices = matched.map((e) => e.args.tradePrice);
    assert.equal(prices[0], marketPrice + tick);
    assert.equal(prices[1], marketPrice + 2n * tick);
    assert.equal(prices[2], marketPrice + 3n * tick);
  });

  it("emits correct entry price and zero net qty on full close", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithOrdersFixture,
    );
    const { perps } = contracts;
    const { seller, buyer2, pc } = accounts;
    const { marketPrice, qty } = config;
    const tick = config.minimumPriceIncrement;

    // buyer2 opens long: buy 1 unit at marketPrice + tick (first sell level)
    await perps.write.createOrder([marketPrice + tick, qty, TimeInForce.GTC], { account: buyer2.account });
    const positionOpen = await perps.read.getUserPosition([buyer2.account.address]);
    assert.equal(positionOpen.netQuantity, qty);
    const entryPrice = positionOpen.aggregatedEntryPrice;

    // buyer2 fully closes: sell 1 unit (match against a resting buy)
    await perps.write.createOrder([marketPrice - tick, qty, TimeInForce.GTC], { account: seller.account });
    const closeHash = await perps.write.createOrder([marketPrice - tick, -qty, TimeInForce.GTC], {
      account: buyer2.account,
    });
    const closeReceipt = await pc.waitForTransactionReceipt({ hash: closeHash });

    const matched = parseEventLogs({
      logs: closeReceipt.logs,
      abi: perps.abi,
      eventName: "OrderMatched",
    });
    assert.equal(matched.length, 1);

    const e = matched[0].args;
    assert.equal(e.taker, getAddress(buyer2.account.address));
    assert.equal(e.takerNetQtyAfter, 0n, "taker position after close should be zero");
    assert.equal(e.takerEntryPriceAfter, entryPrice, "event should emit closed position entry price, not 0");
  });

  it("emits correct makerOrderId linking to the resting order", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { seller, buyer, pc } = accounts;
    const marketPrice = await perps.read.getMarketPrice();
    const qty = parseUnits("1", config.quantityDecimals);

    const sellHash = await perps.write.createOrder([marketPrice, -qty, TimeInForce.GTC], {
      account: seller.account,
    });
    const sellReceipt = await pc.waitForTransactionReceipt({ hash: sellHash });
    const [sellCreated] = parseEventLogs({
      logs: sellReceipt.logs,
      abi: perps.abi,
      eventName: "OrderCreated",
    });
    const makerOrderId = sellCreated.args.orderId;

    const buyHash = await perps.write.createOrder([marketPrice, qty, TimeInForce.GTC], {
      account: buyer.account,
    });
    const buyReceipt = await pc.waitForTransactionReceipt({ hash: buyHash });
    const [{ args }] = parseEventLogs({
      logs: buyReceipt.logs,
      abi: perps.abi,
      eventName: "OrderMatched",
    });

    assert.equal(args.makerOrderId, makerOrderId, "makerOrderId should match the resting order");
  });
});
