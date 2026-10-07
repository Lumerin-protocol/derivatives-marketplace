/**
 * Integration test: owner forced settlement keeps the subgraph equal to the chain.
 *
 * `forceCancelOrders` and `forceClosePositions` replace the old silent `resetState`.
 * Each scenario replays every log from deployment through `src/perps.ts` and then
 * compares the indexed book, users and sessions against the contract views, so any
 * storage change without a matching event shows up as a mismatch.
 *
 * Book before the forced calls (p = mark, t = tick, q = 1 unit):
 *   - seller short 2q (q at p, q at p + 2t), buyer long q at p, buyer2 long q at p + 2t
 *   - asks: seller q left of a 2q order at p + 2t, seller q and buyer2 q at p + 3t
 *   - bids: buyer q and buyer2 q at p - t
 * buyer2 shares both resting levels with a forced user, so a forced cancel must drain
 * a level only partially.
 */
import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { type Address, type Hex, parseEventLogs, zeroAddress } from "viem";
import { deployPerpsWithPositionsFixture } from "../../contracts/tests/fixtures.ts";
import { TimeInForce } from "../../contracts/fixtures/timeInForce.ts";
import { priceLevelId } from "./helpers.ts";

const conn = await network.getOrCreate();
const { matchstick } = conn;

const RESTING = new Set(["ACTIVE", "PARTIALLY_FILLED"]);

async function bookFixture(c: Parameters<typeof deployPerpsWithPositionsFixture>[0]) {
  const data = await deployPerpsWithPositionsFixture(c);
  const { perps } = data.contracts;
  const { owner, seller, buyer, buyer2 } = data.accounts;
  const { marketPrice: p, qty: q, minimumPriceIncrement: t } = data.config;
  const gtc = TimeInForce.GTC;

  await perps.write.setFundingParameters([100n, 86400n], { account: owner.account });
  await perps.write.createOrder([p + 2n * t, -2n * q, gtc], { account: seller.account });
  await perps.write.createOrder([p + 2n * t, q, gtc], { account: buyer2.account });
  await perps.write.createOrder([p + 3n * t, -q, gtc], { account: seller.account });
  await perps.write.createOrder([p + 3n * t, -q, gtc], { account: buyer2.account });
  await perps.write.createOrder([p - t, q, gtc], { account: buyer.account });
  await perps.write.createOrder([p - t, q, gtc], { account: buyer2.account });

  const users = [seller, buyer, buyer2].map((w) => w.account.address);
  return { ...data, users };
}

type Fixture = Awaited<ReturnType<typeof bookFixture>>;
type Snap = Awaited<ReturnType<typeof matchstick.indexSnapshot>>;

async function setup() {
  const fixture = await conn.networkHelpers.loadFixture(bookFixture);
  const { perps } = fixture.contracts;
  matchstick.bind("HashPowerPerpsDEX", perps.address, perps.abi);
  await matchstick.captureViewMocks();
  return fixture;
}

const id = (address: Address) => address.toLowerCase();
const big = (value: unknown) => BigInt(String(value));
const abs = (value: bigint) => (value < 0n ? -value : value);

/** Every indexed order, price level, user and session agrees with the contract views. */
async function assertMatchesChain(snap: Snap, { contracts, users }: Fixture) {
  const { perps } = contracts;

  for (const order of snap.saved("Order")) {
    const onChain = await perps.read.getOrder([String(order.id) as Hex]);
    const resting = onChain.participant !== zeroAddress;
    assert.equal(RESTING.has(String(order.status)), resting, `Order ${order.id} is ${order.status}`);
    assert.equal(big(order.quantity), abs(onChain.quantity), `Order ${order.id} remaining size`);
  }

  const levelCounts = new Map<string, number>();
  let restingCount = 0;
  for (const user of users) {
    const orderIds = await perps.read.getUserOrders([user]);
    restingCount += orderIds.length;
    for (const orderId of orderIds) {
      const order = await perps.read.getOrder([orderId]);
      const key = priceLevelId(order.price, order.quantity > 0n);
      levelCounts.set(key, (levelCounts.get(key) ?? 0) + 1);
    }

    const position = await perps.read.getUserPosition([user]);
    const entity = snap.entity("User", id(user));
    assert.ok(entity, `User ${user} indexed`);
    assert.equal(entity.activeOrderCount, orderIds.length, `User ${user} activeOrderCount`);
    assert.equal(big(entity.netQuantity), position.netQuantity, `User ${user} netQuantity`);
    if (position.netQuantity === 0n) {
      assert.equal(entity.currentSessionId, "", `flat User ${user} has no open session`);
      assert.equal(big(entity.aggregatedEntryPrice), 0n);
    } else {
      const session = snap.entity("PositionSession", String(entity.currentSessionId));
      assert.ok(session, `User ${user} open session indexed`);
      assert.equal(session.status, "OPEN");
      assert.equal(big(session.netQuantity), position.netQuantity);
    }
  }

  for (const level of snap.saved("PriceLevel")) {
    const price = big(level.price);
    assert.equal(
      big(level.totalQuantity),
      await perps.read.getQuantityAtPrice([price, Boolean(level.isBid)]),
      `PriceLevel ${level.id} totalQuantity`,
    );
    assert.equal(level.orderCount, levelCounts.get(String(level.id)) ?? 0, `PriceLevel ${level.id} orderCount`);
  }

  const openSessions = snap.saved("PositionSession").filter((s) => s.status === "OPEN");
  let openPositions = 0;
  for (const user of users) {
    if ((await perps.read.getUserPosition([user])).netQuantity !== 0n) openPositions++;
  }
  assert.equal(openSessions.length, openPositions, "one OPEN session per open position");

  const venue = snap.entity("Perps", "0");
  assert.ok(venue);
  assert.equal(venue.activeOrders, restingCount, "Perps.activeOrders");
  assert.equal(big(venue.cumulativeFundingPerUnit), await perps.read.cumulativeFundingPerUnit());
}

describe("forced settlement: the indexer follows forceCancelOrders and forceClosePositions", () => {
  beforeEach(() => matchstick.reset());
  after(() => matchstick.reset());

  it("forceCancelOrders drops the users' orders, including a partial fill, and leaves positions", async () => {
    const fixture = await setup();
    const { perps, vault } = fixture.contracts;
    const { owner, seller, buyer, buyer2, pc } = fixture.accounts;
    const { marketPrice: p, qty: q, minimumPriceIncrement: t } = fixture.config;
    const [partialId] = await perps.read.getUserOrders([seller.account.address]);
    const bystanderIds = await perps.read.getUserOrders([buyer2.account.address]);

    await vault.write.halt({ account: owner.account });
    const hash = await perps.write.forceCancelOrders([[seller.account.address, buyer.account.address]], {
      account: owner.account,
    });
    const receipt = await pc.waitForTransactionReceipt({ hash });
    assert.equal(parseEventLogs({ abi: perps.abi, logs: receipt.logs, eventName: "OrderCancelled" }).length, 3);

    const snap = await matchstick.indexSnapshot([]);
    await assertMatchesChain(snap, fixture);

    const partial = snap.entity("Order", partialId.toLowerCase());
    assert.ok(partial);
    assert.equal(partial.status, "CANCELLED");
    assert.equal(big(partial.filledQuantity), q);
    assert.equal(big(partial.cancelledQuantity), q, "only the unfilled half is cancelled");
    for (const orderId of bystanderIds) {
      assert.equal(snap.get("Order", orderId.toLowerCase(), "status"), "ACTIVE", "bystander orders stay");
    }
    assert.equal(snap.get("PriceLevel", priceLevelId(p + 2n * t, false), "orderCount"), 0);
    assert.equal(snap.get("PriceLevel", priceLevelId(p + 3n * t, false), "orderCount"), 1);
    assert.equal(snap.get("PriceLevel", priceLevelId(p - t, true), "orderCount"), 1);
    assert.equal(big(snap.get("User", id(seller.account.address), "netQuantity")), -2n * q);
  });

  it("forceClosePositions closes every session at the mark and settles funding into it", async () => {
    const fixture = await setup();
    const { perps, vault } = fixture.contracts;
    const { owner, pc } = fixture.accounts;
    const { users } = fixture;

    await conn.networkHelpers.time.increase(86400);
    await vault.write.halt({ account: owner.account });
    const mark = await perps.read.getMarketPrice();
    const hash = await perps.write.forceClosePositions([users], { account: owner.account });
    const receipt = await pc.waitForTransactionReceipt({ hash });
    const settled = parseEventLogs({ abi: perps.abi, logs: receipt.logs, eventName: "FundingSettled" });
    assert.equal(settled.length, users.length, "each user pays or receives the accrued funding");

    const snap = await matchstick.indexSnapshot([]);
    await assertMatchesChain(snap, fixture);

    const trades = snap.saved("Trade").filter((tr) => String(tr.transactionHash).toLowerCase() === hash);
    assert.equal(trades.length, users.length);
    for (const trade of trades) {
      assert.equal(trade.isLiquidation, true, "a forced close is indexed as a liquidation");
      assert.equal(String(trade.liquidator).toLowerCase(), id(owner.account.address));
      assert.equal(big(trade.liquidationFee), 0n);
      assert.equal(big(trade.tradePrice), mark, "exit price derived from pnl equals the mark");
      assert.equal(big(trade.netQuantityAfter), 0n);

      const session = snap.entity("PositionSession", String(trade.positionSession));
      assert.ok(session);
      assert.equal(session.status, "CLOSE");
      const funding = settled.find((e) => id(e.args.user) === String(trade.user).toLowerCase());
      assert.ok(funding);
      assert.ok(
        snap.saved("FundingSettlement").some(
          (row) => row.positionSession === session.id && big(row.amount) === funding.args.amount,
        ),
        "funding settled in the close tx is attached to the closing session",
      );
    }
    assert.equal(snap.get("Perps", "0", "totalLiquidations"), 1);
  });

  it("both calls empty the venue, and trading after resume opens fresh sessions", async () => {
    const fixture = await setup();
    const { perps, vault } = fixture.contracts;
    const { owner, seller, buyer } = fixture.accounts;
    const { marketPrice: p, qty: q } = fixture.config;
    const { users } = fixture;

    const before = await matchstick.indexSnapshot([]);
    const oldSessions = new Set(before.saved("PositionSession").map((s) => s.id));

    await vault.write.halt({ account: owner.account });
    await perps.write.forceCancelOrders([users], { account: owner.account });
    await perps.write.forceClosePositions([users], { account: owner.account });
    await vault.write.resume({ account: owner.account });

    const flat = await matchstick.indexSnapshot([]);
    await assertMatchesChain(flat, fixture);
    assert.equal(flat.get("Perps", "0", "activeOrders"), 0);
    for (const level of flat.saved("PriceLevel")) {
      assert.equal(level.orderCount, 0, `PriceLevel ${level.id} is empty`);
      assert.equal(big(level.totalQuantity), 0n);
    }
    assert.ok(flat.saved("PositionSession").every((s) => s.status === "CLOSE"));

    await perps.write.createOrder([p, -q, TimeInForce.GTC], { account: seller.account });
    await perps.write.createOrder([p, q, TimeInForce.GTC], { account: buyer.account });

    const reopened = await matchstick.indexSnapshot([]);
    await assertMatchesChain(reopened, fixture);
    for (const user of [seller, buyer]) {
      const sessionId = String(reopened.get("User", id(user.account.address), "currentSessionId"));
      assert.ok(sessionId.length > 0 && !oldSessions.has(sessionId), "a new session, not a revived one");
    }
  });
});
