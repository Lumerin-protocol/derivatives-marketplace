import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits, getAddress, parseEventLogs } from "viem";
import {
  deployPerpsWithCollateralFixture,
  deployPerpsWithOrdersFixture,
} from "./fixtures.ts";

const { networkHelpers } = await network.connect();

describe("PerpsSimple - OrderMatched event", function () {
  it("emits correct maker, taker, price, quantity for a full match", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { seller, buyer, pc } = accounts;
    const marketPrice = await perps.read.getMarketPrice();
    const qty = parseUnits("1", config.quantityDecimals);

    await perps.write.createOrder([marketPrice, -qty], { account: seller.account });

    const hash = await perps.write.createOrder([marketPrice, qty], { account: buyer.account });
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

    await perps.write.createOrder([marketPrice, -qty], { account: seller.account });

    const hash = await perps.write.createOrder([marketPrice, qty], { account: buyer.account });
    const receipt = await pc.waitForTransactionReceipt({ hash });

    const [{ args }] = parseEventLogs({
      logs: receipt.logs,
      abi: perps.abi,
      eventName: "OrderMatched",
    });

    const notional = (marketPrice * qty) / 10n ** BigInt(config.quantityDecimals);
    const expectedTakerFee = (notional * config.takerFeeBps) / 10000n;
    const expectedMakerFee = (notional * config.makerFeeBps) / 10000n;

    const actualTakerFee = args.takerFee > config.liquidationFee ? args.takerFee : config.liquidationFee;
    assert.ok(args.takerFee >= expectedTakerFee, "takerFee should be at least bps fee");
    assert.equal(actualTakerFee, args.takerFee, "takerFee should respect liquidationFee floor");
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

    await perps.write.createOrder([marketPrice, -qty], { account: seller.account });

    const hash = await perps.write.createOrder([marketPrice, qty], { account: buyer.account });
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

    const hash = await perps.write.createOrder([sweepPrice, sweepQty], {
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

  it("emits correct makerOrderId linking to the resting order", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { seller, buyer, pc } = accounts;
    const marketPrice = await perps.read.getMarketPrice();
    const qty = parseUnits("1", config.quantityDecimals);

    const sellHash = await perps.write.createOrder([marketPrice, -qty], {
      account: seller.account,
    });
    const sellReceipt = await pc.waitForTransactionReceipt({ hash: sellHash });
    const [sellCreated] = parseEventLogs({
      logs: sellReceipt.logs,
      abi: perps.abi,
      eventName: "OrderCreated",
    });
    const makerOrderId = sellCreated.args.orderId;

    const buyHash = await perps.write.createOrder([marketPrice, qty], {
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
