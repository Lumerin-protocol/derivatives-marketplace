/**
 * Integration harness smoke test (Section 0 gate).
 *
 * Proves the matchstick-ts harness is wired end-to-end for perps:
 *   - real HashPowerPerpsDEX deploy via the shared contracts fixtures,
 *   - ABI binding + view-mock capture,
 *   - a real `OrderMatched` log replayed through `src/perps.ts`,
 *   - resulting `PositionSession` entities readable from the snapshot.
 *
 * This is the prerequisite gate before any liquidation TDD work: if it is
 * green, the harness + ABI binding + codegen wiring all work.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits } from "viem";
import { deployPerpsWithCollateralFixture } from "../../contracts/tests/fixtures.ts";

const conn = await network.getOrCreate();
const { matchstick } = conn;

describe("perps harness smoke: OrderMatched opens PositionSessions", () => {
  after(() => matchstick.reset());

  it("indexes a matched trade into OPEN PositionSession entities", async () => {
    const { contracts, accounts, config } = await conn.networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { seller, buyer, pc } = accounts;

    const marketPrice = await perps.read.getMarketPrice();
    const qty = parseUnits("1", config.quantityDecimals);

    matchstick.bind("HashPowerPerpsDEX", perps.address, perps.abi);
    await matchstick.captureViewMocks();
    await matchstick.anchor();

    const sellTx = await perps.write.createOrder([marketPrice, -qty], {
      account: seller.account,
    });
    await pc.waitForTransactionReceipt({ hash: sellTx });

    const buyTx = await perps.write.createOrder([marketPrice, qty], {
      account: buyer.account,
    });
    await pc.waitForTransactionReceipt({ hash: buyTx });

    const snap = await matchstick.indexSnapshot([]);

    const sellerAddr = seller.account.address.toLowerCase();
    const buyerAddr = buyer.account.address.toLowerCase();

    const sessions = snap.saved("PositionSession");
    assert.ok(
      sessions.length >= 2,
      `expected at least one PositionSession per side, got ${sessions.length}`,
    );

    const sellerSession = sessions.find((s) => String(s.user).toLowerCase() === sellerAddr);
    const buyerSession = sessions.find((s) => String(s.user).toLowerCase() === buyerAddr);

    assert.ok(sellerSession, "seller PositionSession must exist after the matched trade");
    assert.ok(buyerSession, "buyer PositionSession must exist after the matched trade");

    assert.equal(sellerSession.status, "OPEN", "seller session opens on the matched trade");
    assert.equal(buyerSession.status, "OPEN", "buyer session opens on the matched trade");

    assert.equal(
      String(sellerSession.maxQuantity),
      qty.toString(),
      "seller session maxQuantity is the matched qty",
    );
    assert.equal(
      String(buyerSession.maxQuantity),
      qty.toString(),
      "buyer session maxQuantity is the matched qty",
    );
  });
});
