import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { parseUnits, parseEventLogs } from "viem";
import {
  deployPerpsFixture,
  deployPerpsWithFundingFixture,
  deployPerpsWithFundingAndPositionsFixture,
} from "./fixtures";
import { catchError } from "../lib/lib";

describe("PerpsSimple - Funding Fees", function () {
  // ─────────────────────────────────────────────────
  // Admin
  // ─────────────────────────────────────────────────
  describe("setFundingParameters", function () {
    it("should allow owner to set funding parameters", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { owner } = accounts;

      await perps.write.setFundingParameters([200n, 43200n], { account: owner.account });

      expect(await perps.read.fundingRateMaxBps()).to.equal(200n);
      expect(await perps.read.fundingPeriod()).to.equal(43200n);
      expect((await perps.read.lastFundingUpdateTime()) > 0n).to.be.true;
    });

    it("should revert when non-owner tries to set", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      await catchError(perps.abi, "OwnableUnauthorizedAccount", async () => {
        await perps.write.setFundingParameters([100n, 86400n], { account: buyer.account });
      });
    });

    it("should revert when funding period is zero", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { owner } = accounts;

      await catchError(perps.abi, "InvalidFundingParameters", async () => {
        await perps.write.setFundingParameters([100n, 0n], { account: owner.account });
      });
    });

    it("should emit FundingParametersUpdated event", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsFixture);
      const { perps } = contracts;
      const { owner, pc } = accounts;

      const hash = await perps.write.setFundingParameters([100n, 86400n], {
        account: owner.account,
      });
      const receipt = await pc.waitForTransactionReceipt({ hash });
      const events = parseEventLogs({
        logs: receipt.logs,
        abi: perps.abi,
        eventName: "FundingParametersUpdated",
      });

      expect(events.length).to.equal(1);
      expect(events[0].args.maxBps).to.equal(100n);
      expect(events[0].args.period).to.equal(86400n);
    });
  });

  // ─────────────────────────────────────────────────
  // No-funding scenarios
  // ─────────────────────────────────────────────────
  describe("No funding accrual", function () {
    it("should return zero pending funding when user has no position", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsWithFundingFixture);
      const { perps } = contracts;
      const { buyer2 } = accounts;

      const pending = await perps.read.getPendingFunding([buyer2.account.address]);
      expect(pending).to.equal(0n);
    });

    it("should not accrue funding when order book is empty", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsWithFundingAndPositionsFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      // Order book is empty after matching — no mid-price to compute
      await time.increase(86400);

      const pending = await perps.read.getPendingFunding([buyer.account.address]);
      expect(pending).to.equal(0n);
    });

    it("should not accrue funding when order book is one-sided (bids only)", async function () {
      const { contracts, accounts, config } = await loadFixture(
        deployPerpsWithFundingAndPositionsFixture,
      );
      const { perps } = contracts;
      const { buyer, buyer2 } = accounts;
      const tick = config.minimumPriceIncrement;

      // Place only a bid — no ask side
      const qty = parseUnits("1", config.quantityDecimals);
      await perps.write.createOrder([config.marketPrice - tick, qty], {
        account: buyer2.account,
      });

      await time.increase(86400);

      const pending = await perps.read.getPendingFunding([buyer.account.address]);
      expect(pending).to.equal(0n);
    });

    it("should not accrue funding when order book is one-sided (asks only)", async function () {
      const { contracts, accounts, config } = await loadFixture(
        deployPerpsWithFundingAndPositionsFixture,
      );
      const { perps } = contracts;
      const { buyer, seller } = accounts;
      const tick = config.minimumPriceIncrement;

      // Place only an ask — no bid side
      const qty = parseUnits("1", config.quantityDecimals);
      await perps.write.createOrder([config.marketPrice + tick, -qty], {
        account: seller.account,
      });

      await time.increase(86400);

      const pending = await perps.read.getPendingFunding([buyer.account.address]);
      expect(pending).to.equal(0n);
    });
  });

  // ─────────────────────────────────────────────────
  // Positive funding rate  (mark > index → longs pay, shorts receive)
  // ─────────────────────────────────────────────────
  describe("Positive funding rate (mark > index)", function () {
    it("should charge longs and pay shorts when mark price > index price", async function () {
      const { contracts, accounts, config } = await loadFixture(
        deployPerpsWithFundingAndPositionsFixture,
      );
      const { perps } = contracts;
      const { buyer, seller, buyer2 } = accounts;
      const tick = config.minimumPriceIncrement;

      // Place resting orders so mid-price > oracle price
      // bid at market+1tick, ask at market+3tick → mid = market+2tick
      const bidPrice = config.marketPrice + tick;
      const askPrice = config.marketPrice + 3n * tick;
      const smallQty = parseUnits("1", config.quantityDecimals);

      await perps.write.createOrder([bidPrice, smallQty], { account: buyer2.account });
      await perps.write.createOrder([askPrice, -smallQty], { account: seller.account });

      // Advance 24 hours (one full funding period)
      await time.increase(86400);

      const buyerPending = await perps.read.getPendingFunding([buyer.account.address]);
      const sellerPending = await perps.read.getPendingFunding([seller.account.address]);

      // Long (buyer) should owe funding (positive)
      expect(buyerPending > 0n).to.be.true;
      // Short (seller) should receive funding (negative)
      expect(sellerPending < 0n).to.be.true;
    });

    it("should be approximately zero-sum between longs and shorts", async function () {
      const { contracts, accounts, config } = await loadFixture(
        deployPerpsWithFundingAndPositionsFixture,
      );
      const { perps } = contracts;
      const { buyer, seller, buyer2 } = accounts;
      const tick = config.minimumPriceIncrement;

      const bidPrice = config.marketPrice + tick;
      const askPrice = config.marketPrice + 3n * tick;
      const smallQty = parseUnits("1", config.quantityDecimals);

      await perps.write.createOrder([bidPrice, smallQty], { account: buyer2.account });
      await perps.write.createOrder([askPrice, -smallQty], { account: seller.account });

      await time.increase(86400);

      const buyerPending = await perps.read.getPendingFunding([buyer.account.address]);
      const sellerPending = await perps.read.getPendingFunding([seller.account.address]);

      // Both positions are equal size → |long pays| == |short receives|
      expect(buyerPending).to.equal(-sellerPending);
    });

    it("should compute the exact expected funding amount", async function () {
      const { contracts, accounts, config, utils } = await loadFixture(
        deployPerpsWithFundingAndPositionsFixture,
      );
      const { perps } = contracts;
      const { buyer, buyer2, seller } = accounts;
      const tick = config.minimumPriceIncrement;

      const bidPrice = config.marketPrice + tick;
      const askPrice = config.marketPrice + 3n * tick;
      const smallQty = parseUnits("1", config.quantityDecimals);

      await perps.write.createOrder([bidPrice, smallQty], { account: buyer2.account });
      await perps.write.createOrder([askPrice, -smallQty], { account: seller.account });

      const elapsed = 86400n;
      await time.increase(Number(elapsed));

      const markPrice = (bidPrice + askPrice) / 2n;
      const indexPrice = config.marketPrice;

      const expected = utils.computeExpectedFunding(
        config.qty, // buyer is long config.qty
        markPrice,
        indexPrice,
        elapsed,
      );

      const actual = await perps.read.getPendingFunding([buyer.account.address]);
      expect(actual).to.equal(expected);
    });
  });

  // ─────────────────────────────────────────────────
  // Negative funding rate  (mark < index → shorts pay, longs receive)
  // ─────────────────────────────────────────────────
  describe("Negative funding rate (mark < index)", function () {
    it("should charge shorts and pay longs when mark price < index price", async function () {
      const { contracts, accounts, config } = await loadFixture(
        deployPerpsWithFundingAndPositionsFixture,
      );
      const { perps } = contracts;
      const { buyer, seller, buyer2 } = accounts;
      const tick = config.minimumPriceIncrement;

      // Place resting orders so mid-price < oracle price
      // bid at market-3tick, ask at market-1tick → mid = market-2tick
      const bidPrice = config.marketPrice - 3n * tick;
      const askPrice = config.marketPrice - tick;
      const smallQty = parseUnits("1", config.quantityDecimals);

      await perps.write.createOrder([bidPrice, smallQty], { account: buyer2.account });
      await perps.write.createOrder([askPrice, -smallQty], { account: seller.account });

      await time.increase(86400);

      const buyerPending = await perps.read.getPendingFunding([buyer.account.address]);
      const sellerPending = await perps.read.getPendingFunding([seller.account.address]);

      // Long (buyer) should receive funding (negative)
      expect(buyerPending < 0n).to.be.true;
      // Short (seller) should owe funding (positive)
      expect(sellerPending > 0n).to.be.true;
    });

    it("should compute the exact expected funding amount", async function () {
      const { contracts, accounts, config, utils } = await loadFixture(
        deployPerpsWithFundingAndPositionsFixture,
      );
      const { perps } = contracts;
      const { seller, buyer2 } = accounts;
      const tick = config.minimumPriceIncrement;

      const bidPrice = config.marketPrice - 3n * tick;
      const askPrice = config.marketPrice - tick;
      const smallQty = parseUnits("1", config.quantityDecimals);

      await perps.write.createOrder([bidPrice, smallQty], { account: buyer2.account });
      await perps.write.createOrder([askPrice, -smallQty], { account: seller.account });

      const elapsed = 86400n;
      await time.increase(Number(elapsed));

      const markPrice = (bidPrice + askPrice) / 2n;
      const indexPrice = config.marketPrice;

      // seller is short (negative netQuantity)
      const expected = utils.computeExpectedFunding(-config.qty, markPrice, indexPrice, elapsed);

      const actual = await perps.read.getPendingFunding([seller.account.address]);
      expect(actual).to.equal(expected);
      expect(actual > 0n).to.be.true; // short owes
    });
  });

  // ─────────────────────────────────────────────────
  // Funding scales with time
  // ─────────────────────────────────────────────────
  describe("Funding scales with time", function () {
    it("should accrue more funding over longer periods", async function () {
      const { contracts, accounts, config } = await loadFixture(
        deployPerpsWithFundingAndPositionsFixture,
      );
      const { perps } = contracts;
      const { buyer, seller, buyer2 } = accounts;
      const tick = config.minimumPriceIncrement;

      const bidPrice = config.marketPrice + tick;
      const askPrice = config.marketPrice + 3n * tick;
      const smallQty = parseUnits("1", config.quantityDecimals);

      await perps.write.createOrder([bidPrice, smallQty], { account: buyer2.account });
      await perps.write.createOrder([askPrice, -smallQty], { account: seller.account });

      // Check at 1 hour
      await time.increase(3600);
      const pendingAt1h = await perps.read.getPendingFunding([buyer.account.address]);

      // Check at 12 hours (advance 11 more hours)
      await time.increase(3600 * 11);
      const pendingAt12h = await perps.read.getPendingFunding([buyer.account.address]);

      // Check at 24 hours (advance 12 more hours)
      await time.increase(3600 * 12);
      const pendingAt24h = await perps.read.getPendingFunding([buyer.account.address]);

      expect(pendingAt1h > 0n).to.be.true;
      expect(pendingAt12h > pendingAt1h).to.be.true;
      expect(pendingAt24h > pendingAt12h).to.be.true;

      // 24h should be ~24x of 1h (approximately, due to integer rounding)
      // Allow 1% tolerance
      const ratio = (pendingAt24h * 100n) / pendingAt1h;
      expect(ratio >= 2350n).to.be.true; // ~23.5x to ~24.5x
      expect(ratio <= 2450n).to.be.true;
    });
  });

  // ─────────────────────────────────────────────────
  // Funding rate clamping
  // ─────────────────────────────────────────────────
  describe("Funding rate clamping", function () {
    it("should clamp funding rate to max when deviation is extreme", async function () {
      const { contracts, accounts, config, utils } = await loadFixture(
        deployPerpsWithFundingAndPositionsFixture,
      );
      const { perps } = contracts;
      const { buyer, seller, buyer2 } = accounts;
      const tick = config.minimumPriceIncrement;

      // Place orders far above oracle → extreme positive deviation
      // bid at market+10tick, ask at market+20tick → mid = market+15tick
      // deviation = 15*0.01 / 3.00 ≈ 5%, but max is 1%
      const bidPrice = config.marketPrice + 10n * tick;
      const askPrice = config.marketPrice + 20n * tick;
      const smallQty = parseUnits("1", config.quantityDecimals);

      await perps.write.createOrder([bidPrice, smallQty], { account: buyer2.account });
      await perps.write.createOrder([askPrice, -smallQty], { account: seller.account });

      const elapsed = 86400n;
      await time.increase(Number(elapsed));

      const actualPending = await perps.read.getPendingFunding([buyer.account.address]);

      // Compute what the clamped funding should be (at max rate)
      const expectedClamped = utils.computeExpectedFunding(
        config.qty,
        (bidPrice + askPrice) / 2n,
        config.marketPrice,
        elapsed,
      );

      // Compute what unclamped funding would be (use a huge maxBps)
      const expectedUnclamped = utils.computeExpectedFunding(
        config.qty,
        (bidPrice + askPrice) / 2n,
        config.marketPrice,
        elapsed,
        10000n, // 100% max → effectively no clamp
      );

      expect(actualPending).to.equal(expectedClamped);
      // Clamped result should be less than unclamped
      expect(actualPending < expectedUnclamped).to.be.true;
    });
  });

  // ─────────────────────────────────────────────────
  // updateFunding() – keeper callable
  // ─────────────────────────────────────────────────
  describe("updateFunding()", function () {
    it("should allow anyone to trigger a funding update", async function () {
      const { contracts, accounts, config } = await loadFixture(
        deployPerpsWithFundingAndPositionsFixture,
      );
      const { perps } = contracts;
      const { buyer2, seller } = accounts;
      const tick = config.minimumPriceIncrement;

      const smallQty = parseUnits("1", config.quantityDecimals);
      await perps.write.createOrder([config.marketPrice + tick, smallQty], {
        account: buyer2.account,
      });
      await perps.write.createOrder([config.marketPrice + 3n * tick, -smallQty], {
        account: seller.account,
      });

      await time.increase(3600);

      // buyer2 (not owner) can call updateFunding
      await perps.write.updateFunding({ account: buyer2.account });

      // cumulativeFundingPerUnit should have been updated
      const cumFunding = await perps.read.cumulativeFundingPerUnit();
      expect(cumFunding).to.not.equal(0n);
    });

    it("should emit FundingUpdated event", async function () {
      const { contracts, accounts, config } = await loadFixture(
        deployPerpsWithFundingAndPositionsFixture,
      );
      const { perps } = contracts;
      const { buyer2, seller, pc } = accounts;
      const tick = config.minimumPriceIncrement;

      const smallQty = parseUnits("1", config.quantityDecimals);
      await perps.write.createOrder([config.marketPrice + tick, smallQty], {
        account: buyer2.account,
      });
      await perps.write.createOrder([config.marketPrice + 3n * tick, -smallQty], {
        account: seller.account,
      });

      await time.increase(3600);

      const hash = await perps.write.updateFunding({ account: buyer2.account });
      const receipt = await pc.waitForTransactionReceipt({ hash });
      const events = parseEventLogs({
        logs: receipt.logs,
        abi: perps.abi,
        eventName: "FundingUpdated",
      });

      expect(events.length).to.equal(1);
      expect(events[0].args.cumulativeFundingPerUnit).to.not.equal(0n);
    });
  });

  // ─────────────────────────────────────────────────
  // Funding settlement on interaction
  // ─────────────────────────────────────────────────
  describe("Funding settlement", function () {
    it("should settle funding when a matching trade occurs (positive rate)", async function () {
      const { contracts, accounts, config } = await loadFixture(
        deployPerpsWithFundingAndPositionsFixture,
      );
      const { perps } = contracts;
      const { buyer, seller, buyer2 } = accounts;
      const tick = config.minimumPriceIncrement;

      // Set up order book with mark > index
      // buyer2 bids at mkt+tick, seller asks at mkt+3tick
      const smallQty = parseUnits("1", config.quantityDecimals);
      await perps.write.createOrder([config.marketPrice + tick, smallQty], {
        account: buyer2.account,
      });
      await perps.write.createOrder([config.marketPrice + 3n * tick, -smallQty], {
        account: seller.account,
      });

      await time.increase(86400);

      // Buyer's pending funding (positive = owes)
      const pendingBefore = await perps.read.getPendingFunding([buyer.account.address]);
      expect(pendingBefore > 0n).to.be.true;

      // Buyer sells into buyer2's bid → triggers _updateUserPosition → _settleFunding
      // This partially closes buyer's long position by 1 unit at buyer2's bid price
      await perps.write.createOrder([config.marketPrice + tick, -smallQty], {
        account: buyer.account,
      });

      // Pending funding should be ~0 after settlement (settled during match)
      const pendingAfter = await perps.read.getPendingFunding([buyer.account.address]);
      expect(pendingAfter).to.equal(0n);
    });

    it("should settle funding when a matching trade occurs (negative rate)", async function () {
      const { contracts, accounts, config } = await loadFixture(
        deployPerpsWithFundingAndPositionsFixture,
      );
      const { perps } = contracts;
      const { buyer, seller, buyer2 } = accounts;
      const tick = config.minimumPriceIncrement;

      // Set up order book with mark < index
      const smallQty = parseUnits("1", config.quantityDecimals);
      await perps.write.createOrder([config.marketPrice - 3n * tick, smallQty], {
        account: buyer2.account,
      });
      await perps.write.createOrder([config.marketPrice - tick, -smallQty], {
        account: seller.account,
      });

      await time.increase(86400);

      // Buyer has long position and mark < index → buyer receives funding (negative pending)
      const pendingBefore = await perps.read.getPendingFunding([buyer.account.address]);
      expect(pendingBefore < 0n).to.be.true;

      // Buyer buys at seller's ask → triggers _updateUserPosition → _settleFunding
      await perps.write.createOrder([config.marketPrice - tick, smallQty], {
        account: buyer.account,
      });

      // Verify settlement happened: pending goes to 0
      const pendingAfter = await perps.read.getPendingFunding([buyer.account.address]);
      expect(pendingAfter).to.equal(0n);
    });

    it("should emit FundingSettled event on settlement", async function () {
      const { contracts, accounts, config } = await loadFixture(
        deployPerpsWithFundingAndPositionsFixture,
      );
      const { perps } = contracts;
      const { buyer, seller, buyer2, pc } = accounts;
      const tick = config.minimumPriceIncrement;

      // Set up order book with mark > index
      const smallQty = parseUnits("1", config.quantityDecimals);
      await perps.write.createOrder([config.marketPrice + tick, smallQty], {
        account: buyer2.account,
      });
      await perps.write.createOrder([config.marketPrice + 3n * tick, -smallQty], {
        account: seller.account,
      });

      await time.increase(86400);

      // Buyer sells into buyer2's bid → triggers settlement via match
      const hash = await perps.write.createOrder([config.marketPrice + tick, -smallQty], {
        account: buyer.account,
      });
      const receipt = await pc.waitForTransactionReceipt({ hash });
      const events = parseEventLogs({
        logs: receipt.logs,
        abi: perps.abi,
        eventName: "FundingSettled",
      });

      expect(events.length >= 1).to.be.true;
      // Find the event for the buyer
      const buyerEvent = events.find(
        (e) => e.args.user.toLowerCase() === buyer.account.address.toLowerCase(),
      );
      expect(buyerEvent).to.not.be.undefined;
      expect(buyerEvent!.args.amount > 0n).to.be.true; // buyer owes (positive)
    });

    it("should settle funding before liquidation", async function () {
      const { contracts, accounts, config, utils } = await loadFixture(deployPerpsFixture);
      const { perps, priceOracle } = contracts;
      const { seller, buyer, buyer2, owner } = accounts;

      // Enable funding
      await perps.write.setFundingParameters([100n, 86400n], { account: owner.account });

      const initialPrice = await perps.read.getMarketPrice();
      const qty = parseUnits("1", config.quantityDecimals);
      const tick = config.minimumPriceIncrement;

      // Give seller just enough collateral for a position
      const minCollateral = utils.getMinimumCollateral(initialPrice, qty);
      await perps.write.addCollateral([minCollateral], { account: seller.account });
      await perps.write.addCollateral([minCollateral * 2n], { account: buyer.account });

      // Create matching positions
      await perps.write.createOrder([initialPrice, -qty], { account: seller.account });
      await perps.write.createOrder([initialPrice, qty], { account: buyer.account });

      // Place resting orders so mark > index (this will hurt the short seller via funding)
      const smallQty = parseUnits("0.1", config.quantityDecimals);
      await perps.write.createOrder([initialPrice + tick, smallQty], {
        account: buyer.account,
      });
      await perps.write.createOrder([initialPrice + 3n * tick, -smallQty], {
        account: seller.account,
      });

      // Advance time to accrue funding against the short
      await time.increase(86400);

      // Now also move price up to put seller closer to liquidation
      const newPrice = initialPrice * 2n;
      await priceOracle.write.setPrice([newPrice, config.oracle.decimals]);

      // Seller should be liquidatable (combination of price move + funding)
      const isLiquidatable = await perps.read.isLiquidatable([seller.account.address]);
      expect(isLiquidatable).to.be.true;

      // Liquidate
      await perps.write.liquidate([seller.account.address], { account: buyer2.account });

      // Position should be cleared
      const position = await perps.read.getUserPosition([seller.account.address]);
      expect(position.netQuantity).to.equal(0n);

      // Pending funding should be zero after liquidation (settled)
      const pendingAfter = await perps.read.getPendingFunding([seller.account.address]);
      expect(pendingAfter).to.equal(0n);
    });
  });

  // ─────────────────────────────────────────────────
  // Funding and margin requirements
  // ─────────────────────────────────────────────────
  describe("Funding and margin requirements", function () {
    it("should include pending funding owed in required margin", async function () {
      const { contracts, accounts, config } = await loadFixture(
        deployPerpsWithFundingAndPositionsFixture,
      );
      const { perps } = contracts;
      const { buyer, seller, buyer2 } = accounts;
      const tick = config.minimumPriceIncrement;

      // Record margin before funding accrues
      const marginBefore = await perps.read.getRequiredMargin([buyer.account.address]);

      // Set up order book with mark > index
      const smallQty = parseUnits("1", config.quantityDecimals);
      await perps.write.createOrder([config.marketPrice + tick, smallQty], {
        account: buyer2.account,
      });
      await perps.write.createOrder([config.marketPrice + 3n * tick, -smallQty], {
        account: seller.account,
      });

      await time.increase(86400);

      const marginAfter = await perps.read.getRequiredMargin([buyer.account.address]);
      const pendingFunding = await perps.read.getPendingFunding([buyer.account.address]);

      // Buyer owes funding → margin should increase by the pending amount
      expect(pendingFunding > 0n).to.be.true;
      expect(marginAfter).to.equal(marginBefore + pendingFunding);
    });

    it("should include pending funding owed in maintenance margin", async function () {
      const { contracts, accounts, config } = await loadFixture(
        deployPerpsWithFundingAndPositionsFixture,
      );
      const { perps } = contracts;
      const { buyer, seller, buyer2 } = accounts;
      const tick = config.minimumPriceIncrement;

      const maintenanceBefore = await perps.read.getMaintenanceMargin([buyer.account.address]);

      const smallQty = parseUnits("1", config.quantityDecimals);
      await perps.write.createOrder([config.marketPrice + tick, smallQty], {
        account: buyer2.account,
      });
      await perps.write.createOrder([config.marketPrice + 3n * tick, -smallQty], {
        account: seller.account,
      });

      await time.increase(86400);

      const maintenanceAfter = await perps.read.getMaintenanceMargin([buyer.account.address]);
      const pendingFunding = await perps.read.getPendingFunding([buyer.account.address]);

      expect(pendingFunding > 0n).to.be.true;
      expect(maintenanceAfter).to.equal(maintenanceBefore + pendingFunding);
    });

    it("should not increase margin when user receives funding", async function () {
      const { contracts, accounts, config } = await loadFixture(
        deployPerpsWithFundingAndPositionsFixture,
      );
      const { perps } = contracts;
      const { buyer, seller, buyer2 } = accounts;
      const tick = config.minimumPriceIncrement;

      const marginBefore = await perps.read.getRequiredMargin([buyer.account.address]);

      // Set up book with mark < index → buyer (long) receives funding
      const smallQty = parseUnits("1", config.quantityDecimals);
      await perps.write.createOrder([config.marketPrice - 3n * tick, smallQty], {
        account: buyer2.account,
      });
      await perps.write.createOrder([config.marketPrice - tick, -smallQty], {
        account: seller.account,
      });

      await time.increase(86400);

      const marginAfter = await perps.read.getRequiredMargin([buyer.account.address]);
      const pendingFunding = await perps.read.getPendingFunding([buyer.account.address]);

      // Buyer receives funding (negative) → should NOT increase margin
      expect(pendingFunding < 0n).to.be.true;
      expect(marginAfter).to.equal(marginBefore);
    });
  });

  // ─────────────────────────────────────────────────
  // Funding and unrealized PnL
  // ─────────────────────────────────────────────────
  describe("Funding and unrealized PnL", function () {
    it("should subtract pending funding owed from unrealized PnL", async function () {
      const { contracts, accounts, config } = await loadFixture(
        deployPerpsWithFundingAndPositionsFixture,
      );
      const { perps } = contracts;
      const { buyer, seller, buyer2 } = accounts;
      const tick = config.minimumPriceIncrement;

      // With no price movement, base PnL is 0
      // Set up order book with mark > index → buyer owes funding
      const smallQty = parseUnits("1", config.quantityDecimals);
      await perps.write.createOrder([config.marketPrice + tick, smallQty], {
        account: buyer2.account,
      });
      await perps.write.createOrder([config.marketPrice + 3n * tick, -smallQty], {
        account: seller.account,
      });

      await time.increase(86400);

      const pnl = await perps.read.getUnrealizedPnl([buyer.account.address]);
      const pendingFunding = await perps.read.getPendingFunding([buyer.account.address]);

      // PnL should be negative (funding owed reduces it from 0)
      expect(pnl < 0n).to.be.true;
      expect(pnl).to.equal(-pendingFunding);
    });

    it("should add pending funding received to unrealized PnL", async function () {
      const { contracts, accounts, config } = await loadFixture(
        deployPerpsWithFundingAndPositionsFixture,
      );
      const { perps } = contracts;
      const { buyer, seller, buyer2 } = accounts;
      const tick = config.minimumPriceIncrement;

      // Set up book with mark < index → buyer (long) receives
      const smallQty = parseUnits("1", config.quantityDecimals);
      await perps.write.createOrder([config.marketPrice - 3n * tick, smallQty], {
        account: buyer2.account,
      });
      await perps.write.createOrder([config.marketPrice - tick, -smallQty], {
        account: seller.account,
      });

      await time.increase(86400);

      const pnl = await perps.read.getUnrealizedPnl([buyer.account.address]);
      const pendingFunding = await perps.read.getPendingFunding([buyer.account.address]);

      // PnL should be positive (funding received adds to 0 base PnL)
      expect(pnl > 0n).to.be.true;
      expect(pnl).to.equal(-pendingFunding);
    });
  });
});
