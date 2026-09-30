/**
 * Integration test: the protocol backstop after a perps liquidation.
 *
 * `liquidatePosition` closes the seller at the mark and hands the closed
 * quantity to `BACKSTOP_ADDR` (`BackstopAssigned`). A permissionless
 * `unwindBackstop` then buys back part of that short from the buyer's ask,
 * emitting an ordinary `OrderMatched` (backstop as taker) plus `BackstopUnwound`.
 *
 * Asserts the indexer keeps the position pointers conserved (sum == 0 across
 * users incl. the backstop), flags the hand-off Trade, and records the unwind.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { maxUint256, parseEventLogs } from "viem";
import type { EntityFields } from "matchstick-ts";
import { deployPerpsWithLiquidatablePositionFixture } from "../../contracts/tests/fixtures.ts";
import { TimeInForce } from "../../contracts/fixtures/timeInForce.ts";

const conn = await network.getOrCreate();
const { matchstick } = conn;

const BACKSTOP_ADDR = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("protocol backstop: BackstopAssigned + BackstopUnwound", () => {
  after(() => matchstick.reset());

  it("moves the liquidated quantity onto the backstop pointer and records the unwind", async () => {
    const fixture = await conn.networkHelpers.loadFixture(
      deployPerpsWithLiquidatablePositionFixture,
    );
    const { contracts, accounts, config } = fixture;
    const { perps, vault } = contracts;
    const { seller, buyer, owner, pc } = accounts;

    matchstick.bind("HashPowerPerpsDEX", perps.address, perps.abi);
    await matchstick.captureViewMocks();

    const mark = await fixture.makeLiquidatable();
    await vault.write.setBackstopParams([100, 10], { account: owner.account });

    const liqTx = await perps.write.liquidatePosition([seller.account.address, maxUint256], {
      account: owner.account,
    });
    const liqReceipt = await pc.waitForTransactionReceipt({ hash: liqTx });
    const [assigned] = parseEventLogs({
      logs: liqReceipt.logs,
      abi: perps.abi,
      eventName: "BackstopAssigned",
    });
    assert.ok(assigned, "liquidatePosition must emit BackstopAssigned");
    assert.equal(assigned.args.quantity, -config.qty, "backstop inherits the seller's short");
    assert.equal(assigned.args.price, mark);

    // The buyer offers half its long at the mark; the unwind lifts it.
    const half = config.qty / 2n;
    await perps.write.createOrder([mark, -half, TimeInForce.GTC], { account: buyer.account });
    const unwindTx = await perps.write.unwindBackstop([half], { account: owner.account });
    const unwindReceipt = await pc.waitForTransactionReceipt({ hash: unwindTx });
    const [unwound] = parseEventLogs({
      logs: unwindReceipt.logs,
      abi: perps.abi,
      eventName: "BackstopUnwound",
    });
    assert.ok(unwound, "unwindBackstop must emit BackstopUnwound");
    assert.equal(unwound.args.filledQuantity, half);
    assert.ok(unwound.args.fee > 0n, "caller is paid an unwind fee");

    const snap = await matchstick.indexSnapshot([]);

    const sellerAddr = seller.account.address.toLowerCase();
    const buyerAddr = buyer.account.address.toLowerCase();
    const net = (addr: string) => BigInt(String(snap.entity("User", addr)?.netQuantity ?? "0"));

    // ---- Position pointers: seller flat, buyer half, backstop -half; sum == 0 ----
    assert.equal(net(sellerAddr), 0n, "seller is flat after the full liquidation");
    assert.equal(net(buyerAddr), config.qty - half, "buyer sold half its long to the backstop");
    assert.equal(net(BACKSTOP_ADDR), -half, "backstop keeps the un-covered half of the short");
    assert.equal(net(sellerAddr) + net(buyerAddr) + net(BACKSTOP_ADDR), 0n, "conservation");

    const backstopUser = snap.entity("User", BACKSTOP_ADDR);
    assert.ok(backstopUser);
    assert.equal(
      String(backstopUser.aggregatedEntryPrice),
      mark.toString(),
      "backstop entry is the liquidation mark",
    );
    // Covered at the same mark it inherited → zero realized PnL on the cover.
    assert.equal(String(backstopUser.realizedPnl), "0");

    // ---- Hand-off Trade: flagged, no Fill rows ----
    let handOff: EntityFields | undefined;
    let cover: EntityFields | undefined;
    for (const t of snap.saved("Trade")) {
      if (String(t.user).toLowerCase() !== BACKSTOP_ADDR) continue;
      if (String(t.transactionHash).toLowerCase() === liqTx.toLowerCase()) handOff = t;
      if (String(t.transactionHash).toLowerCase() === unwindTx.toLowerCase()) cover = t;
    }
    assert.ok(handOff, "backstop gets a Trade in the liquidation tx");
    assert.equal(handOff.isBackstopAssignment, true);
    assert.equal(String(handOff.backstopFromUser).toLowerCase(), sellerAddr);
    assert.equal(String(handOff.tradeQuantity), (-config.qty).toString());
    assert.equal(String(handOff.tradePrice), mark.toString());
    assert.equal(String(handOff.fillCount), "0", "hand-off has no matched order");
    assert.equal(String(handOff.netQuantityAfter), (-config.qty).toString());

    // ---- Cover Trade comes from the ordinary OrderMatched path ----
    assert.ok(cover, "backstop gets a Trade in the unwind tx");
    assert.equal(cover.isBackstopAssignment, false);
    assert.equal(String(cover.tradeQuantity), half.toString());
    assert.equal(String(cover.fillCount), "1");
    assert.equal(String(cover.tradingFee), "0", "backstop pays no taker fee");
    assert.equal(String(cover.netQuantityAfter), (-half).toString());
    assert.equal(
      String(cover.positionSession),
      String(handOff.positionSession),
      "cover reduces the session the hand-off opened",
    );

    const session = snap.entity("PositionSession", String(handOff.positionSession));
    assert.ok(session);
    assert.equal(session.status, "OPEN");
    assert.equal(String(session.closedQuantity), half.toString());
    assert.equal(String(session.maxQuantity), config.qty.toString());

    let backstopFills = 0;
    for (const f of snap.saved("Fill")) {
      if (String(f.user).toLowerCase() === BACKSTOP_ADDR) backstopFills++;
    }
    assert.equal(backstopFills, 1, "only the cover produces a backstop Fill");

    // ---- BackstopUnwind record ----
    const unwinds = snap.saved("BackstopUnwind");
    assert.equal(unwinds.length, 1);
    const [row] = unwinds;
    assert.equal(String(row.caller).toLowerCase(), owner.account.address.toLowerCase());
    assert.equal(String(row.filledQuantity), half.toString());
    assert.equal(String(row.fee), unwound.args.fee.toString());
    assert.equal(String(row.transactionHash).toLowerCase(), unwindTx.toLowerCase());
  });
});
