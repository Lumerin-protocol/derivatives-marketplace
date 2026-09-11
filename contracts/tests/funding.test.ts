import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { maxUint256, parseUnits, parseEventLogs } from "viem";
import {
  deployPerpsFixture,
  deployPerpsWithFundingFixture,
  deployPerpsWithFundingAndPositionsFixture,
} from "./fixtures.ts";
import { catchError } from "../lib/lib.ts";
import { TimeInForce } from "../fixtures/timeInForce.ts";

const { networkHelpers } = await network.connect();

describe("HashPowerPerpsDEX - Funding Fees", function () {
  describe("setFundingParameters", function () {
    it("should allow owner to set funding parameters", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { owner } = accounts;

      await perps.write.setFundingParameters([200n, 43200n], { account: owner.account });

      assert.equal(await perps.read.fundingRateMaxBps(), 200n);
      assert.equal(await perps.read.fundingPeriod(), 43200n);
      assert.ok((await perps.read.lastFundingUpdateTime()) > 0n);
    });

    it("should revert when non-owner tries to set", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      await catchError(perps.abi, "OwnableUnauthorizedAccount", async () => {
        await perps.write.setFundingParameters([100n, 86400n], { account: buyer.account });
      });
    });

    it("should revert when funding period is zero", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { owner } = accounts;

      await catchError(perps.abi, "InvalidFundingParameters", async () => {
        await perps.write.setFundingParameters([100n, 0n], { account: owner.account });
      });
    });

    it("should emit FundingParametersUpdated event", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { owner, pc } = accounts;

      const hash = await perps.write.setFundingParameters([100n, 86400n], { account: owner.account });
      const receipt = await pc.waitForTransactionReceipt({ hash });
      const events = parseEventLogs({
        logs: receipt.logs,
        abi: perps.abi,
        eventName: "FundingParametersUpdated",
      });

      assert.equal(events.length, 1);
      assert.equal(events[0].args.maxBps, 100n);
      assert.equal(events[0].args.period, 86400n);
    });
  });

  describe("No funding accrual", function () {
    it("should return zero pending funding when user has no position", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithFundingFixture);
      const { perps } = contracts;
      const { buyer2 } = accounts;

      const pending = await perps.read.getPendingFunding([buyer2.account.address]);
      assert.equal(pending, 0n);
    });

    it("should not accrue funding when order book is empty", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithFundingAndPositionsFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      await networkHelpers.time.increase(86400);

      const pending = await perps.read.getPendingFunding([buyer.account.address]);
      assert.equal(pending, 0n);
    });

    it("should not accrue funding when order book is one-sided (bids only)", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithFundingAndPositionsFixture);
      const { perps } = contracts;
      const { buyer, buyer2 } = accounts;
      const tick = config.minimumPriceIncrement;

      const qty = parseUnits("1", config.quantityDecimals);
      await perps.write.createOrder([config.marketPrice - tick, qty, TimeInForce.GTC], { account: buyer2.account });

      await networkHelpers.time.increase(86400);

      const pending = await perps.read.getPendingFunding([buyer.account.address]);
      assert.equal(pending, 0n);
    });

    it("should not accrue funding when order book is one-sided (asks only)", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithFundingAndPositionsFixture);
      const { perps } = contracts;
      const { buyer, seller } = accounts;
      const tick = config.minimumPriceIncrement;

      const qty = parseUnits("1", config.quantityDecimals);
      await perps.write.createOrder([config.marketPrice + tick, -qty, TimeInForce.GTC], { account: seller.account });

      await networkHelpers.time.increase(86400);

      const pending = await perps.read.getPendingFunding([buyer.account.address]);
      assert.equal(pending, 0n);
    });
  });

  describe("Positive funding rate (mark > index)", function () {
    it("should charge longs and pay shorts when mark price > index price", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithFundingAndPositionsFixture);
      const { perps } = contracts;
      const { buyer, seller, buyer2 } = accounts;
      const tick = config.minimumPriceIncrement;

      const bidPrice = config.marketPrice + tick;
      const askPrice = config.marketPrice + 3n * tick;
      const smallQty = parseUnits("1", config.quantityDecimals);

      await perps.write.createOrder([bidPrice, smallQty, TimeInForce.GTC], { account: buyer2.account });
      await perps.write.createOrder([askPrice, -smallQty, TimeInForce.GTC], { account: seller.account });

      await networkHelpers.time.increase(86400);

      const buyerPending = await perps.read.getPendingFunding([buyer.account.address]);
      const sellerPending = await perps.read.getPendingFunding([seller.account.address]);

      assert.ok(buyerPending > 0n);
      assert.ok(sellerPending < 0n);
    });

    it("should be approximately zero-sum between longs and shorts", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithFundingAndPositionsFixture);
      const { perps } = contracts;
      const { buyer, seller, buyer2 } = accounts;
      const tick = config.minimumPriceIncrement;

      const bidPrice = config.marketPrice + tick;
      const askPrice = config.marketPrice + 3n * tick;
      const smallQty = parseUnits("1", config.quantityDecimals);

      await perps.write.createOrder([bidPrice, smallQty, TimeInForce.GTC], { account: buyer2.account });
      await perps.write.createOrder([askPrice, -smallQty, TimeInForce.GTC], { account: seller.account });

      await networkHelpers.time.increase(86400);

      const buyerPending = await perps.read.getPendingFunding([buyer.account.address]);
      const sellerPending = await perps.read.getPendingFunding([seller.account.address]);

      assert.equal(buyerPending, -sellerPending);
    });

    it("should compute the exact expected funding amount", async function () {
      const { contracts, accounts, config, utils } = await networkHelpers.loadFixture(deployPerpsWithFundingAndPositionsFixture);
      const { perps } = contracts;
      const { buyer, buyer2, seller } = accounts;
      const tick = config.minimumPriceIncrement;

      const bidPrice = config.marketPrice + tick;
      const askPrice = config.marketPrice + 3n * tick;
      const smallQty = parseUnits("1", config.quantityDecimals);

      await perps.write.createOrder([bidPrice, smallQty, TimeInForce.GTC], { account: buyer2.account });
      await perps.write.createOrder([askPrice, -smallQty, TimeInForce.GTC], { account: seller.account });

      const elapsed = 86400n;
      await networkHelpers.time.increase(Number(elapsed));

      const markPrice = (bidPrice + askPrice) / 2n;
      const indexPrice = config.marketPrice;

      const expected = utils.computeExpectedFunding(config.qty, markPrice, indexPrice, elapsed);
      const actual = await perps.read.getPendingFunding([buyer.account.address]);
      assert.equal(actual, expected);
    });
  });

  describe("Negative funding rate (mark < index)", function () {
    it("should charge shorts and pay longs when mark price < index price", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithFundingAndPositionsFixture);
      const { perps } = contracts;
      const { buyer, seller, buyer2 } = accounts;
      const tick = config.minimumPriceIncrement;

      const bidPrice = config.marketPrice - 3n * tick;
      const askPrice = config.marketPrice - tick;
      const smallQty = parseUnits("1", config.quantityDecimals);

      await perps.write.createOrder([bidPrice, smallQty, TimeInForce.GTC], { account: buyer2.account });
      await perps.write.createOrder([askPrice, -smallQty, TimeInForce.GTC], { account: seller.account });

      await networkHelpers.time.increase(86400);

      const buyerPending = await perps.read.getPendingFunding([buyer.account.address]);
      const sellerPending = await perps.read.getPendingFunding([seller.account.address]);

      assert.ok(buyerPending < 0n);
      assert.ok(sellerPending > 0n);
    });

    it("should compute the exact expected funding amount", async function () {
      const { contracts, accounts, config, utils } = await networkHelpers.loadFixture(deployPerpsWithFundingAndPositionsFixture);
      const { perps } = contracts;
      const { seller, buyer2 } = accounts;
      const tick = config.minimumPriceIncrement;

      const bidPrice = config.marketPrice - 3n * tick;
      const askPrice = config.marketPrice - tick;
      const smallQty = parseUnits("1", config.quantityDecimals);

      await perps.write.createOrder([bidPrice, smallQty, TimeInForce.GTC], { account: buyer2.account });
      await perps.write.createOrder([askPrice, -smallQty, TimeInForce.GTC], { account: seller.account });

      const elapsed = 86400n;
      await networkHelpers.time.increase(Number(elapsed));

      const markPrice = (bidPrice + askPrice) / 2n;
      const indexPrice = config.marketPrice;

      const expected = utils.computeExpectedFunding(-config.qty, markPrice, indexPrice, elapsed);
      const actual = await perps.read.getPendingFunding([seller.account.address]);
      assert.equal(actual, expected);
      assert.ok(actual > 0n);
    });
  });

  describe("Funding scales with time", function () {
    it("should accrue more funding over longer periods", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithFundingAndPositionsFixture);
      const { perps } = contracts;
      const { buyer, seller, buyer2 } = accounts;
      const tick = config.minimumPriceIncrement;

      const bidPrice = config.marketPrice + tick;
      const askPrice = config.marketPrice + 3n * tick;
      const smallQty = parseUnits("1", config.quantityDecimals);

      await perps.write.createOrder([bidPrice, smallQty, TimeInForce.GTC], { account: buyer2.account });
      await perps.write.createOrder([askPrice, -smallQty, TimeInForce.GTC], { account: seller.account });

      await networkHelpers.time.increase(3600);
      const pendingAt1h = await perps.read.getPendingFunding([buyer.account.address]);

      await networkHelpers.time.increase(3600 * 11);
      const pendingAt12h = await perps.read.getPendingFunding([buyer.account.address]);

      await networkHelpers.time.increase(3600 * 12);
      const pendingAt24h = await perps.read.getPendingFunding([buyer.account.address]);

      assert.ok(pendingAt1h > 0n);
      assert.ok(pendingAt12h > pendingAt1h);
      assert.ok(pendingAt24h > pendingAt12h);

      const ratio = (pendingAt24h * 100n) / pendingAt1h;
      assert.ok(ratio >= 2350n);
      assert.ok(ratio <= 2450n);
    });
  });

  describe("Funding rate clamping", function () {
    it("should clamp funding rate to max when deviation is extreme", async function () {
      const { contracts, accounts, config, utils } = await networkHelpers.loadFixture(deployPerpsWithFundingAndPositionsFixture);
      const { perps } = contracts;
      const { buyer, seller, buyer2 } = accounts;
      const tick = config.minimumPriceIncrement;

      // Offsets scale with the mark (now 10x the oracle answer) so the mark-vs-index
      // deviation still exceeds the 1% funding-rate clamp.
      const bidPrice = config.marketPrice + 100n * tick;
      const askPrice = config.marketPrice + 200n * tick;
      const smallQty = parseUnits("1", config.quantityDecimals);

      await perps.write.createOrder([bidPrice, smallQty, TimeInForce.GTC], { account: buyer2.account });
      await perps.write.createOrder([askPrice, -smallQty, TimeInForce.GTC], { account: seller.account });

      const elapsed = 86400n;
      await networkHelpers.time.increase(Number(elapsed));

      const actualPending = await perps.read.getPendingFunding([buyer.account.address]);

      const expectedClamped = utils.computeExpectedFunding(
        config.qty,
        (bidPrice + askPrice) / 2n,
        config.marketPrice,
        elapsed,
      );

      const expectedUnclamped = utils.computeExpectedFunding(
        config.qty,
        (bidPrice + askPrice) / 2n,
        config.marketPrice,
        elapsed,
        10000n,
      );

      assert.equal(actualPending, expectedClamped);
      assert.ok(actualPending < expectedUnclamped);
    });
  });

  describe("updateFunding()", function () {
    it("should allow anyone to trigger a funding update", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithFundingAndPositionsFixture);
      const { perps } = contracts;
      const { buyer2, seller } = accounts;
      const tick = config.minimumPriceIncrement;

      const smallQty = parseUnits("1", config.quantityDecimals);
      await perps.write.createOrder([config.marketPrice + tick, smallQty, TimeInForce.GTC], { account: buyer2.account });
      await perps.write.createOrder([config.marketPrice + 3n * tick, -smallQty, TimeInForce.GTC], { account: seller.account });

      await networkHelpers.time.increase(3600);

      await perps.write.updateFunding({ account: buyer2.account });

      const cumFunding = await perps.read.cumulativeFundingPerUnit();
      assert.notEqual(cumFunding, 0n);
    });

    it("should emit FundingUpdated event", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithFundingAndPositionsFixture);
      const { perps } = contracts;
      const { buyer2, seller, pc } = accounts;
      const tick = config.minimumPriceIncrement;

      const smallQty = parseUnits("1", config.quantityDecimals);
      await perps.write.createOrder([config.marketPrice + tick, smallQty, TimeInForce.GTC], { account: buyer2.account });
      await perps.write.createOrder([config.marketPrice + 3n * tick, -smallQty, TimeInForce.GTC], { account: seller.account });

      await networkHelpers.time.increase(3600);

      const hash = await perps.write.updateFunding({ account: buyer2.account });
      const receipt = await pc.waitForTransactionReceipt({ hash });
      const events = parseEventLogs({
        logs: receipt.logs,
        abi: perps.abi,
        eventName: "FundingUpdated",
      });

      assert.equal(events.length, 1);
      assert.notEqual(events[0].args.cumulativeFundingPerUnit, 0n);
    });
  });

  describe("Funding settlement", function () {
    it("should settle funding when a matching trade occurs (positive rate)", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithFundingAndPositionsFixture);
      const { perps } = contracts;
      const { buyer, seller, buyer2 } = accounts;
      const tick = config.minimumPriceIncrement;

      const smallQty = parseUnits("1", config.quantityDecimals);
      await perps.write.createOrder([config.marketPrice + tick, smallQty, TimeInForce.GTC], { account: buyer2.account });
      await perps.write.createOrder([config.marketPrice + 3n * tick, -smallQty, TimeInForce.GTC], { account: seller.account });

      await networkHelpers.time.increase(86400);

      const pendingBefore = await perps.read.getPendingFunding([buyer.account.address]);
      assert.ok(pendingBefore > 0n);

      await perps.write.createOrder([config.marketPrice + tick, -smallQty, TimeInForce.GTC], { account: buyer.account });

      const pendingAfter = await perps.read.getPendingFunding([buyer.account.address]);
      assert.equal(pendingAfter, 0n);
    });

    it("should settle funding when a matching trade occurs (negative rate)", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithFundingAndPositionsFixture);
      const { perps } = contracts;
      const { buyer, seller, buyer2 } = accounts;
      const tick = config.minimumPriceIncrement;

      const smallQty = parseUnits("1", config.quantityDecimals);
      await perps.write.createOrder([config.marketPrice - 3n * tick, smallQty, TimeInForce.GTC], { account: buyer2.account });
      await perps.write.createOrder([config.marketPrice - tick, -smallQty, TimeInForce.GTC], { account: seller.account });

      await networkHelpers.time.increase(86400);

      const pendingBefore = await perps.read.getPendingFunding([buyer.account.address]);
      assert.ok(pendingBefore < 0n);

      await perps.write.createOrder([config.marketPrice - tick, smallQty, TimeInForce.GTC], { account: buyer.account });

      const pendingAfter = await perps.read.getPendingFunding([buyer.account.address]);
      assert.equal(pendingAfter, 0n);
    });

    it("should emit FundingSettled event on settlement", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithFundingAndPositionsFixture);
      const { perps } = contracts;
      const { buyer, seller, buyer2, pc } = accounts;
      const tick = config.minimumPriceIncrement;

      const smallQty = parseUnits("1", config.quantityDecimals);
      await perps.write.createOrder([config.marketPrice + tick, smallQty, TimeInForce.GTC], { account: buyer2.account });
      await perps.write.createOrder([config.marketPrice + 3n * tick, -smallQty, TimeInForce.GTC], { account: seller.account });

      await networkHelpers.time.increase(86400);

      const hash = await perps.write.createOrder([config.marketPrice + tick, -smallQty, TimeInForce.GTC], { account: buyer.account });
      const receipt = await pc.waitForTransactionReceipt({ hash });
      const events = parseEventLogs({
        logs: receipt.logs,
        abi: perps.abi,
        eventName: "FundingSettled",
      });

      assert.ok(events.length >= 1);
      const buyerEvent = events.find(
        (e) => e.args.user.toLowerCase() === buyer.account.address.toLowerCase(),
      );
      assert.ok(buyerEvent !== undefined);
      assert.ok(buyerEvent?.args.amount > 0n);
    });

    it("should settle funding before liquidation", async function () {
      const { contracts, accounts, config, utils } = await networkHelpers.loadFixture(deployPerpsFixture);
      const { perps, pme, priceOracle, vault } = contracts;
      const { seller, buyer, buyer2, owner } = accounts;

      await perps.write.setFundingParameters([100n, 86400n], { account: owner.account });

      const initialPrice = await perps.read.getMarketPrice();
      const qty = parseUnits("1", config.quantityDecimals);
      const tick = config.minimumPriceIncrement;

      const minCollateral = utils.getMinimumCollateral(initialPrice, qty);
      await vault.write.deposit([minCollateral], { account: seller.account });
      await vault.write.deposit([minCollateral * 2n], { account: buyer.account });

      await perps.write.createOrder([initialPrice, -qty, TimeInForce.GTC], { account: seller.account });
      await perps.write.createOrder([initialPrice, qty, TimeInForce.GTC], { account: buyer.account });

      const smallQty = parseUnits("0.1", config.quantityDecimals);
      await perps.write.createOrder([initialPrice + tick, smallQty, TimeInForce.GTC], { account: buyer.account });
      await perps.write.createOrder([initialPrice + 3n * tick, -smallQty, TimeInForce.GTC], { account: seller.account });

      await networkHelpers.time.increase(86400);

      const newPrice = initialPrice * 2n;
      await priceOracle.write.setPrice([newPrice, config.oracle.decimals]);

      const isLiquidatable = await pme.read.isLiquidatable([seller.account.address]);
      assert.ok(isLiquidatable);

      // Strict orders-first invariant: must cancel resting orders before the position can be liquidated.
      const sellerOrders = await perps.read.getUserOrders([seller.account.address]);
      if (sellerOrders.length > 0) {
        await perps.write.liquidateOrders([seller.account.address, sellerOrders], {
          account: buyer2.account,
        });
      }

      await perps.write.liquidatePosition([seller.account.address, maxUint256], { account: buyer2.account });

      const position = await perps.read.getUserPosition([seller.account.address]);
      assert.equal(position.netQuantity, 0n);

      const pendingAfter = await perps.read.getPendingFunding([seller.account.address]);
      assert.equal(pendingAfter, 0n);
    });
  });

  describe("Funding and margin requirements", function () {
    it("should include pending funding owed in maintenance margin", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithFundingAndPositionsFixture);
      const { perps, pme } = contracts;
      const { buyer, seller, buyer2 } = accounts;
      const tick = config.minimumPriceIncrement;

      const maintenanceBefore = await pme.read.computePortfolioMM([buyer.account.address]);

      const smallQty = parseUnits("1", config.quantityDecimals);
      await perps.write.createOrder([config.marketPrice + tick, smallQty, TimeInForce.GTC], { account: buyer2.account });
      await perps.write.createOrder([config.marketPrice + 3n * tick, -smallQty, TimeInForce.GTC], { account: seller.account });

      await networkHelpers.time.increase(86400);

      const maintenanceAfter = await pme.read.computePortfolioMM([buyer.account.address]);
      const pendingFunding = await perps.read.getPendingFunding([buyer.account.address]);

      assert.ok(pendingFunding > 0n);
      // Exactly once: the engine adds `unrealizedPnl` losses and `pendingFunding`
      // as independent terms, so `getRiskView` must not net funding into the PnL.
      assert.equal(maintenanceAfter, maintenanceBefore + pendingFunding);
    });

    it("should report mark PnL to the margin engine without netting funding", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithFundingAndPositionsFixture);
      const { perps } = contracts;
      const { buyer, seller, buyer2 } = accounts;
      const tick = config.minimumPriceIncrement;

      const smallQty = parseUnits("1", config.quantityDecimals);
      await perps.write.createOrder([config.marketPrice + tick, smallQty, TimeInForce.GTC], { account: buyer2.account });
      await perps.write.createOrder([config.marketPrice + 3n * tick, -smallQty, TimeInForce.GTC], { account: seller.account });

      await networkHelpers.time.increase(86400);

      const view = await perps.read.getRiskView([buyer.account.address]);
      const pendingFunding = await perps.read.getPendingFunding([buyer.account.address]);
      const uxPnl = await perps.read.getUnrealizedPnl([buyer.account.address]);

      assert.ok(pendingFunding > 0n);
      assert.equal(view.pendingFunding, pendingFunding);
      // The margin input carries mark PnL only; the UX view still nets funding out.
      assert.equal(view.unrealizedPnl - pendingFunding, uxPnl);
    });

    it("should not increase margin when user receives funding", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithFundingAndPositionsFixture);
      const { perps, pme } = contracts;
      const { buyer, seller, buyer2 } = accounts;
      const tick = config.minimumPriceIncrement;

      const marginBefore = await pme.read.computePortfolioMM([buyer.account.address]);

      const smallQty = parseUnits("1", config.quantityDecimals);
      await perps.write.createOrder([config.marketPrice - 3n * tick, smallQty, TimeInForce.GTC], { account: buyer2.account });
      await perps.write.createOrder([config.marketPrice - tick, -smallQty, TimeInForce.GTC], { account: seller.account });

      await networkHelpers.time.increase(86400);

      const marginAfter = await pme.read.computePortfolioMM([buyer.account.address]);
      const pendingFunding = await perps.read.getPendingFunding([buyer.account.address]);

      assert.ok(pendingFunding < 0n);
      assert.equal(marginAfter, marginBefore);
    });
  });

  describe("Funding and unrealized PnL", function () {
    it("should subtract pending funding owed from unrealized PnL", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithFundingAndPositionsFixture);
      const { perps } = contracts;
      const { buyer, seller, buyer2 } = accounts;
      const tick = config.minimumPriceIncrement;

      const smallQty = parseUnits("1", config.quantityDecimals);
      await perps.write.createOrder([config.marketPrice + tick, smallQty, TimeInForce.GTC], { account: buyer2.account });
      await perps.write.createOrder([config.marketPrice + 3n * tick, -smallQty, TimeInForce.GTC], { account: seller.account });

      await networkHelpers.time.increase(86400);

      const pnl = await perps.read.getUnrealizedPnl([buyer.account.address]);
      const pendingFunding = await perps.read.getPendingFunding([buyer.account.address]);

      assert.ok(pnl < 0n);
      assert.equal(pnl, -pendingFunding);
    });

    it("should add pending funding received to unrealized PnL", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithFundingAndPositionsFixture);
      const { perps } = contracts;
      const { buyer, seller, buyer2 } = accounts;
      const tick = config.minimumPriceIncrement;

      const smallQty = parseUnits("1", config.quantityDecimals);
      await perps.write.createOrder([config.marketPrice - 3n * tick, smallQty, TimeInForce.GTC], { account: buyer2.account });
      await perps.write.createOrder([config.marketPrice - tick, -smallQty, TimeInForce.GTC], { account: seller.account });

      await networkHelpers.time.increase(86400);

      const pnl = await perps.read.getUnrealizedPnl([buyer.account.address]);
      const pendingFunding = await perps.read.getPendingFunding([buyer.account.address]);

      assert.ok(pnl > 0n);
      assert.equal(pnl, -pendingFunding);
    });
  });
});
