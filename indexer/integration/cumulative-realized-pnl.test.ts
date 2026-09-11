/**
 * matchstick-ts: Trade.cumulativeRealizedPnl is the user's lifetime realized
 * PnL after that trade. Sequential open→close sessions accumulate on one User.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits } from "viem";
import type { EntityFields } from "matchstick-ts";
import { deployPerpsWithCollateralFixture } from "../../contracts/tests/fixtures.ts";
import { TimeInForce } from "../../contracts/fixtures/timeInForce.ts";

const conn = await network.getOrCreate();
const { matchstick } = conn;

function tradesOf(rows: EntityFields[], user: string): EntityFields[] {
  return rows
    .filter((t) => String(t.user).toLowerCase() === user)
    .sort((a, b) => {
      const ts = Number(a.timestamp) - Number(b.timestamp);
      if (ts !== 0) return ts;
      return Number(a.blockNumber) - Number(b.blockNumber);
    });
}

describe("Trade.cumulativeRealizedPnl", () => {
  after(() => matchstick.reset());

  it("snapshots 0 on open, then lifetime total across two sessions", async () => {
    const { contracts, accounts, config } = await conn.networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { seller, buyer, pc } = accounts;

    const openPrice = await perps.read.getMarketPrice();
    const tick = config.minimumPriceIncrement;
    const closePrice = openPrice + tick;
    const qty = parseUnits("1", config.quantityDecimals);
    const scale = 10n ** BigInt(config.quantityDecimals);
    const expectedClosePnl = (tick * qty) / scale;

    matchstick.bind("HashPowerPerpsDEX", perps.address, perps.abi);
    await matchstick.captureViewMocks();
    await matchstick.anchor();

    const buyerAddr = buyer.account.address.toLowerCase();

    const matchAt = async (price: bigint, sellerQty: bigint) => {
      const restTx = await perps.write.createOrder([price, sellerQty, TimeInForce.GTC], {
        account: seller.account,
      });
      await pc.waitForTransactionReceipt({ hash: restTx });
      const takeTx = await perps.write.createOrder(
        [price, -sellerQty, TimeInForce.GTC],
        { account: buyer.account },
      );
      await pc.waitForTransactionReceipt({ hash: takeTx });
    };

    await matchAt(openPrice, -qty);
    await matchAt(closePrice, qty);
    await matchAt(openPrice, -qty);
    await matchAt(closePrice, qty);

    const snap = await matchstick.indexSnapshot([]);
    const buyerTrades = tradesOf(snap.saved("Trade"), buyerAddr);
    assert.equal(buyerTrades.length, 4, "buyer has open+close on each of two sessions");

    assert.equal(String(buyerTrades[0].realizedPnl), "0");
    assert.equal(String(buyerTrades[0].cumulativeRealizedPnl), "0");

    assert.equal(String(buyerTrades[1].realizedPnl), expectedClosePnl.toString());
    assert.equal(
      String(buyerTrades[1].cumulativeRealizedPnl),
      expectedClosePnl.toString(),
    );

    assert.equal(String(buyerTrades[2].realizedPnl), "0");
    assert.equal(
      String(buyerTrades[2].cumulativeRealizedPnl),
      expectedClosePnl.toString(),
      "second open snapshots the prior lifetime total",
    );

    assert.equal(String(buyerTrades[3].realizedPnl), expectedClosePnl.toString());
    assert.equal(
      String(buyerTrades[3].cumulativeRealizedPnl),
      (expectedClosePnl * 2n).toString(),
    );

    const buyerUser = snap.entity("User", buyerAddr);
    assert.ok(buyerUser);
    assert.equal(
      String(buyerUser.realizedPnl),
      String(buyerTrades[3].cumulativeRealizedPnl),
    );
  });
});
