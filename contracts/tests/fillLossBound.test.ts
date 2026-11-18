import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { deployPerpsFixture } from "./fixtures.ts";

const { viem, networkHelpers } = await network.connect();

type Order = { price: bigint; qty: bigint };

const MASK_64 = (1n << 64n) - 1n;

/** Deterministic xorshift64, so a failing book reproduces. Returns a value in [0, bound). */
function rng(seed: bigint) {
  let s = seed;
  return (bound: bigint) => {
    s = (s ^ (s << 13n)) & MASK_64;
    s ^= s >> 7n;
    s = (s ^ (s << 17n)) & MASK_64;
    return s % bound;
  };
}

/** The aggregate the venue keeps for one side: Σq, Σp·q, Σp²·q. */
function moments(orders: Order[]) {
  let qty = 0n;
  let pq = 0n;
  let p2q = 0n;
  for (const order of orders) {
    qty += order.qty;
    pq += order.price * order.qty;
    p2q += order.price * order.price * order.qty;
  }
  return { qty, pq, p2q };
}

/** Exact instant loss if every order on the side fills at its own price against `mark`. */
function fillLoss(orders: Order[], mark: bigint, isBuy: boolean): bigint {
  let loss = 0n;
  for (const { price, qty } of orders) {
    const edge = isBuy ? price - mark : mark - price;
    if (edge > 0n) loss += edge * qty;
  }
  return loss;
}

describe("MathLib.fillLossBound", function () {
  async function setup() {
    const { contracts, config } = await networkHelpers.loadFixture(deployPerpsFixture);
    const { perps } = contracts;
    const harness = await viem.deployContract("MathLibHarness");
    const bound = (orders: Order[], mark: bigint, isBuy: boolean) => {
      const { qty, pq, p2q } = moments(orders);
      return harness.read.fillLossBound([qty, pq, p2q, mark, isBuy]);
    };
    return {
      bound,
      mark: await perps.read.getMarketPrice(),
      tick: config.minimumPriceIncrement,
      lot: 1_000n * 10n ** BigInt(await perps.read.QUANTITY_DECIMALS()),
      maxOrders: BigInt(await perps.read.MAX_ORDERS_PER_PARTICIPANT()),
      maxPrice: await perps.read.MAX_PRICE(),
      maxQty: await perps.read.MAX_ORDER_QUANTITY(),
    };
  }

  it("stays in range and never under-reserves with every order at the caps", async function () {
    const { bound, tick, maxOrders, maxPrice, maxQty } = await setup();
    // A full side at the quantity cap, split between the lowest price and MAX_PRICE: the
    // widest spread, and so the largest `qty · Σq(p−m)²`, the caps allow.
    const orders: Order[] = [];
    for (let i = 0n; i < maxOrders; i++) {
      orders.push({ price: i % 2n === 0n ? tick : maxPrice, qty: maxQty });
    }
    for (const at of [tick, maxPrice / 2n, maxPrice]) {
      for (const isBuy of [true, false]) {
        const exact = fillLoss(orders, at, isBuy);
        const got = await bound(orders, at, isBuy);
        assert.ok(got >= exact, `mark ${at}, ${isBuy ? "bids" : "asks"}: ${got} < ${exact}`);
      }
    }
  });

  it("is zero for an empty side", async function () {
    const { bound, mark } = await setup();
    assert.equal(await bound([], mark, true), 0n);
    assert.equal(await bound([], mark, false), 0n);
  });

  it("is exact for a single price level", async function () {
    const { bound, mark, tick, lot } = await setup();
    for (let offset = -20n; offset <= 20n; offset++) {
      const orders = [{ price: mark + offset * 50n * tick, qty: lot }];
      for (const isBuy of [true, false]) {
        assert.equal(await bound(orders, mark, isBuy), fillLoss(orders, mark, isBuy), `offset ${offset}`);
      }
    }
  });

  it("does not let a deep decoy hide a marketable order", async function () {
    const { bound, mark, tick, lot } = await setup();
    const marketable = { price: mark + 500n * tick, qty: lot };
    const decoy = { price: mark / 2n, qty: 100n * lot };
    const orders = [marketable, decoy];

    // Netted per side, the decoy's discount cancels the marketable bid's premium.
    const { qty, pq } = moments(orders);
    assert.ok(pq < mark * qty);

    const exact = fillLoss(orders, mark, true);
    assert.equal(exact, fillLoss([marketable], mark, true));
    assert.ok((await bound(orders, mark, true)) >= exact);
  });

  it("never under-reserves a random book at any mark", async function () {
    const { bound, mark, tick, lot, maxOrders } = await setup();
    const next = rng(0x9e3779b97f4a7c15n);
    // Orders within ±50% of the mark, on the tick grid.
    const spanTicks = mark / 2n / tick;
    for (let book = 0; book < 40; book++) {
      const count = 1n + next(maxOrders);
      const orders: Order[] = [];
      for (let i = 0n; i < count; i++) {
        const price = mark - spanTicks * tick + next(2n * spanTicks + 1n) * tick;
        orders.push({ price, qty: 1n + next(lot) });
      }
      const prices = orders.map((o) => o.price);
      const lowest = prices.reduce((a, b) => (a < b ? a : b));
      const highest = prices.reduce((a, b) => (a > b ? a : b));
      const marks = [mark, lowest, highest, lowest - tick, highest + tick, mark - spanTicks * tick / 4n];
      for (const at of marks) {
        for (const isBuy of [true, false]) {
          const exact = fillLoss(orders, at, isBuy);
          const got = await bound(orders, at, isBuy);
          assert.ok(got >= exact, `book ${book}, mark ${at}, ${isBuy ? "bids" : "asks"}: ${got} < ${exact}`);
        }
      }
    }
  });
});
