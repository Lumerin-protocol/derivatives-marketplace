import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { deployBookWithSeriesFixture } from "./optionsFixtures.ts";

const { networkHelpers } = await network.getOrCreate();

describe("OptionOrderBook", () => {
  // ── Placement ──────────────────────────────────────────────────────────

  describe("placeOrder", () => {
    it("places a bid and updates best bid", async () => {
      const { book, seriesId, accounts } = await networkHelpers.loadFixture(deployBookWithSeriesFixture);
      const { owner } = accounts;

      await book.write.placeOrder(
        [seriesId, owner.account.address, true, 100n, 1_000_000n, false, false],
        { account: owner.account },
      );

      const [bidOrderId, bidPrice] = await book.read.bestBid([seriesId]);
      assert.equal(bidOrderId, 1n);
      assert.equal(bidPrice, 100n);
    });

    it("places an ask and updates best ask", async () => {
      const { book, seriesId, accounts } = await networkHelpers.loadFixture(deployBookWithSeriesFixture);
      const { owner } = accounts;

      await book.write.placeOrder(
        [seriesId, owner.account.address, false, 200n, 1_000_000n, false, false],
        { account: owner.account },
      );

      const [askOrderId, askPrice] = await book.read.bestAsk([seriesId]);
      assert.equal(askOrderId, 1n);
      assert.equal(askPrice, 200n);
    });

    it("best bid = highest of multiple bids", async () => {
      const { book, seriesId, accounts } = await networkHelpers.loadFixture(deployBookWithSeriesFixture);
      const { owner } = accounts;

      await book.write.placeOrder([seriesId, owner.account.address, true, 100n, 1_000_000n, false, false], { account: owner.account });
      await book.write.placeOrder([seriesId, owner.account.address, true, 150n, 1_000_000n, false, false], { account: owner.account });
      await book.write.placeOrder([seriesId, owner.account.address, true, 120n, 1_000_000n, false, false], { account: owner.account });

      const [, bidPrice] = await book.read.bestBid([seriesId]);
      assert.equal(bidPrice, 150n);
    });

    it("best ask = lowest of multiple asks", async () => {
      const { book, seriesId, accounts } = await networkHelpers.loadFixture(deployBookWithSeriesFixture);
      const { owner } = accounts;

      await book.write.placeOrder([seriesId, owner.account.address, false, 300n, 1_000_000n, false, false], { account: owner.account });
      await book.write.placeOrder([seriesId, owner.account.address, false, 200n, 1_000_000n, false, false], { account: owner.account });
      await book.write.placeOrder([seriesId, owner.account.address, false, 250n, 1_000_000n, false, false], { account: owner.account });

      const [, askPrice] = await book.read.bestAsk([seriesId]);
      assert.equal(askPrice, 200n);
    });

    it("reverts for non-router caller", async () => {
      const { book, seriesId, accounts } = await networkHelpers.loadFixture(deployBookWithSeriesFixture);
      await assert.rejects(
        book.write.placeOrder(
          [seriesId, accounts.admin.account.address, true, 100n, 1_000_000n, false, false],
          { account: accounts.admin.account },
        ),
      );
    });

    it("reverts for zero price", async () => {
      const { book, seriesId, accounts } = await networkHelpers.loadFixture(deployBookWithSeriesFixture);
      await assert.rejects(
        book.write.placeOrder([seriesId, accounts.owner.account.address, true, 0n, 1_000_000n, false, false], { account: accounts.owner.account }),
      );
    });

    it("reverts for zero size", async () => {
      const { book, seriesId, accounts } = await networkHelpers.loadFixture(deployBookWithSeriesFixture);
      await assert.rejects(
        book.write.placeOrder([seriesId, accounts.owner.account.address, true, 100n, 0n, false, false], { account: accounts.owner.account }),
      );
    });
  });

  // ── FIFO ordering ─────────────────────────────────────────────────────

  describe("FIFO within price level", () => {
    it("orders at the same price are returned in FIFO order", async () => {
      const { book, seriesId, accounts } = await networkHelpers.loadFixture(deployBookWithSeriesFixture);
      const { owner } = accounts;

      await book.write.placeOrder([seriesId, owner.account.address, true, 100n, 1_000_000n, false, false], { account: owner.account });
      await book.write.placeOrder([seriesId, owner.account.address, true, 100n, 2_000_000n, false, false], { account: owner.account });
      await book.write.placeOrder([seriesId, owner.account.address, true, 100n, 3_000_000n, false, false], { account: owner.account });

      const [headOrderId] = await book.read.bestBid([seriesId]);
      assert.equal(headOrderId, 1n); // first placed

      const order1 = await book.read.getOrder([1n]);
      assert.equal(order1.size, 1_000_000n);

      const depth = await book.read.levelDepth([seriesId, true, 100n]);
      assert.equal(depth, 3n);
    });
  });

  // ── Cancellation ──────────────────────────────────────────────────────

  describe("cancelOrder", () => {
    it("cancels and clears remaining", async () => {
      const { book, seriesId, accounts } = await networkHelpers.loadFixture(deployBookWithSeriesFixture);
      const { owner } = accounts;

      await book.write.placeOrder([seriesId, owner.account.address, true, 100n, 1_000_000n, false, false], { account: owner.account });
      await book.write.cancelOrder([1n], { account: owner.account });

      assert.equal(await book.read.isOrderActive([1n]), false);

      const [bidOrderId, bidPrice] = await book.read.bestBid([seriesId]);
      assert.equal(bidOrderId, 0n);
      assert.equal(bidPrice, 0n);
    });

    it("cancel head promotes next order", async () => {
      const { book, seriesId, accounts } = await networkHelpers.loadFixture(deployBookWithSeriesFixture);
      const { owner } = accounts;

      await book.write.placeOrder([seriesId, owner.account.address, false, 200n, 1_000_000n, false, false], { account: owner.account });
      await book.write.placeOrder([seriesId, owner.account.address, false, 200n, 2_000_000n, false, false], { account: owner.account });

      await book.write.cancelOrder([1n], { account: owner.account });

      const [headOrderId] = await book.read.bestAsk([seriesId]);
      assert.equal(headOrderId, 2n);
    });

    it("cancel middle preserves head and tail", async () => {
      const { book, seriesId, accounts } = await networkHelpers.loadFixture(deployBookWithSeriesFixture);
      const { owner } = accounts;

      await book.write.placeOrder([seriesId, owner.account.address, true, 100n, 1_000_000n, false, false], { account: owner.account });
      await book.write.placeOrder([seriesId, owner.account.address, true, 100n, 2_000_000n, false, false], { account: owner.account });
      await book.write.placeOrder([seriesId, owner.account.address, true, 100n, 3_000_000n, false, false], { account: owner.account });

      await book.write.cancelOrder([2n], { account: owner.account });

      assert.equal(await book.read.levelDepth([seriesId, true, 100n]), 2n);

      const [headOrderId] = await book.read.bestBid([seriesId]);
      assert.equal(headOrderId, 1n);

      const nextAfterHead = await book.read.nextOrderInQueue([seriesId, true, 100n, 1n]);
      assert.equal(nextAfterHead, 3n);
    });

    it("cancel best bid → next level becomes best", async () => {
      const { book, seriesId, accounts } = await networkHelpers.loadFixture(deployBookWithSeriesFixture);
      const { owner } = accounts;

      await book.write.placeOrder([seriesId, owner.account.address, true, 100n, 1_000_000n, false, false], { account: owner.account });
      await book.write.placeOrder([seriesId, owner.account.address, true, 150n, 1_000_000n, false, false], { account: owner.account });

      await book.write.cancelOrder([2n], { account: owner.account }); // cancel 150

      const [, bidPrice] = await book.read.bestBid([seriesId]);
      assert.equal(bidPrice, 100n);
    });

    it("cancel best ask → next level becomes best", async () => {
      const { book, seriesId, accounts } = await networkHelpers.loadFixture(deployBookWithSeriesFixture);
      const { owner } = accounts;

      await book.write.placeOrder([seriesId, owner.account.address, false, 200n, 1_000_000n, false, false], { account: owner.account });
      await book.write.placeOrder([seriesId, owner.account.address, false, 300n, 1_000_000n, false, false], { account: owner.account });

      await book.write.cancelOrder([1n], { account: owner.account }); // cancel 200

      const [, askPrice] = await book.read.bestAsk([seriesId]);
      assert.equal(askPrice, 300n);
    });

    it("reverts when cancelling already-cancelled order", async () => {
      const { book, seriesId, accounts } = await networkHelpers.loadFixture(deployBookWithSeriesFixture);
      const { owner } = accounts;

      await book.write.placeOrder([seriesId, owner.account.address, true, 100n, 1_000_000n, false, false], { account: owner.account });
      await book.write.cancelOrder([1n], { account: owner.account });

      await assert.rejects(
        book.write.cancelOrder([1n], { account: owner.account }),
      );
    });
  });

  // ── Fill ────────────────────────────────────────────────────────────────

  describe("fillOrder", () => {
    it("partial fill reduces remaining", async () => {
      const { book, seriesId, accounts } = await networkHelpers.loadFixture(deployBookWithSeriesFixture);
      const { owner } = accounts;

      await book.write.placeOrder([seriesId, owner.account.address, false, 200n, 5_000_000n, false, false], { account: owner.account });

      await book.write.fillOrder([1n, 2_000_000n], { account: owner.account });

      const order = await book.read.getOrder([1n]);
      assert.equal(order.remaining, 3_000_000n);
      assert.equal(await book.read.isOrderActive([1n]), true);
    });

    it("full fill removes from book", async () => {
      const { book, seriesId, accounts } = await networkHelpers.loadFixture(deployBookWithSeriesFixture);
      const { owner } = accounts;

      await book.write.placeOrder([seriesId, owner.account.address, false, 200n, 5_000_000n, false, false], { account: owner.account });

      await book.write.fillOrder([1n, 5_000_000n], { account: owner.account });

      assert.equal(await book.read.isOrderActive([1n]), false);
      const [askOrderId, askPrice] = await book.read.bestAsk([seriesId]);
      assert.equal(askOrderId, 0n);
      assert.equal(askPrice, 0n);
    });

    it("fill returns price and trader", async () => {
      const { book, seriesId, accounts } = await networkHelpers.loadFixture(deployBookWithSeriesFixture);
      const { owner } = accounts;

      await book.write.placeOrder([seriesId, owner.account.address, true, 100n, 1_000_000n, false, false], { account: owner.account });

      // Simulate fill via staticCall to read return values
      const pc = accounts.pc;
      const result = await pc.simulateContract({
        address: book.address,
        abi: book.abi,
        functionName: "fillOrder",
        args: [1n, 1_000_000n],
        account: owner.account.address,
      });

      assert.equal(result.result[0], 100n); // priceTicks
      assert.equal(result.result[1].toLowerCase(), owner.account.address.toLowerCase()); // trader
    });

    it("reverts when fill exceeds remaining", async () => {
      const { book, seriesId, accounts } = await networkHelpers.loadFixture(deployBookWithSeriesFixture);
      const { owner } = accounts;

      await book.write.placeOrder([seriesId, owner.account.address, false, 200n, 3_000_000n, false, false], { account: owner.account });

      await assert.rejects(
        book.write.fillOrder([1n, 5_000_000n], { account: owner.account }),
      );
    });

    it("full fill at best ask → next level becomes best", async () => {
      const { book, seriesId, accounts } = await networkHelpers.loadFixture(deployBookWithSeriesFixture);
      const { owner } = accounts;

      await book.write.placeOrder([seriesId, owner.account.address, false, 200n, 1_000_000n, false, false], { account: owner.account });
      await book.write.placeOrder([seriesId, owner.account.address, false, 250n, 1_000_000n, false, false], { account: owner.account });

      await book.write.fillOrder([1n, 1_000_000n], { account: owner.account });

      const [, askPrice] = await book.read.bestAsk([seriesId]);
      assert.equal(askPrice, 250n);
    });
  });

  // ── Level traversal ──────────────────────────────────────────────────────

  describe("nextLevel", () => {
    it("walks bid levels in descending order", async () => {
      const { book, seriesId, accounts } = await networkHelpers.loadFixture(deployBookWithSeriesFixture);
      const { owner } = accounts;

      await book.write.placeOrder([seriesId, owner.account.address, true, 100n, 1_000_000n, false, false], { account: owner.account });
      await book.write.placeOrder([seriesId, owner.account.address, true, 120n, 1_000_000n, false, false], { account: owner.account });
      await book.write.placeOrder([seriesId, owner.account.address, true, 80n, 1_000_000n, false, false], { account: owner.account });

      const [, bestPrice] = await book.read.bestBid([seriesId]);
      assert.equal(bestPrice, 120n);

      const [nextTick, found] = await book.read.nextLevel([seriesId, true, 120n]);
      assert.equal(found, true);
      assert.equal(nextTick, 100n);

      const [nextTick2, found2] = await book.read.nextLevel([seriesId, true, 100n]);
      assert.equal(found2, true);
      assert.equal(nextTick2, 80n);

      const [, found3] = await book.read.nextLevel([seriesId, true, 80n]);
      assert.equal(found3, false);
    });

    it("walks ask levels in ascending order", async () => {
      const { book, seriesId, accounts } = await networkHelpers.loadFixture(deployBookWithSeriesFixture);
      const { owner } = accounts;

      await book.write.placeOrder([seriesId, owner.account.address, false, 200n, 1_000_000n, false, false], { account: owner.account });
      await book.write.placeOrder([seriesId, owner.account.address, false, 250n, 1_000_000n, false, false], { account: owner.account });
      await book.write.placeOrder([seriesId, owner.account.address, false, 300n, 1_000_000n, false, false], { account: owner.account });

      const [, bestPrice] = await book.read.bestAsk([seriesId]);
      assert.equal(bestPrice, 200n);

      const [nextTick, found] = await book.read.nextLevel([seriesId, false, 200n]);
      assert.equal(found, true);
      assert.equal(nextTick, 250n);

      const [nextTick2, found2] = await book.read.nextLevel([seriesId, false, 250n]);
      assert.equal(found2, true);
      assert.equal(nextTick2, 300n);
    });
  });

  // ── Empty book ────────────────────────────────────────────────────────

  describe("empty book", () => {
    it("bestBid returns (0, 0) when no bids", async () => {
      const { book, seriesId } = await networkHelpers.loadFixture(deployBookWithSeriesFixture);
      const [orderId, price] = await book.read.bestBid([seriesId]);
      assert.equal(orderId, 0n);
      assert.equal(price, 0n);
    });

    it("bestAsk returns (0, 0) when no asks", async () => {
      const { book, seriesId } = await networkHelpers.loadFixture(deployBookWithSeriesFixture);
      const [orderId, price] = await book.read.bestAsk([seriesId]);
      assert.equal(orderId, 0n);
      assert.equal(price, 0n);
    });
  });
});
