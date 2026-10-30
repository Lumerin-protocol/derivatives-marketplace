import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseEventLogs } from "viem";
import { TimeInForce } from "../fixtures/timeInForce.ts";
import { deployPerpsWithFundingFixture } from "./fixtures.ts";

const { networkHelpers } = await network.connect();

describe("HashPowerPerpsDEX.forceCancelOrders funding checkpoint", function () {
  it("accrues funding over the two-sided window before emptying the book", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithFundingFixture);
    const { perps } = contracts;
    const { owner, buyer, seller, pc } = accounts;
    const index = await perps.read.getMarketPrice();
    const tick = config.minimumPriceIncrement;

    // Mid = index + 2 ticks: the book pays positive funding while it is two-sided.
    await perps.write.createOrder([index + tick, 1n, TimeInForce.GTC], { account: buyer.account });
    await perps.write.createOrder([index + 3n * tick, -1n, TimeInForce.GTC], { account: seller.account });
    await networkHelpers.time.increase(3600);
    const cumBefore = await perps.read.cumulativeFundingPerUnit();

    const hash = await perps.write.forceCancelOrders([[buyer.account.address, seller.account.address]], {
      account: owner.account,
    });
    const receipt = await pc.waitForTransactionReceipt({ hash });
    const block = await pc.getBlock({ blockNumber: receipt.blockNumber });

    const updates = parseEventLogs({ abi: perps.abi, logs: receipt.logs, eventName: "FundingUpdated" });
    assert.equal(updates.length, 1, "funding is checkpointed in the cancel transaction");
    assert.ok((await perps.read.cumulativeFundingPerUnit()) > cumBefore, "the two-sided hour accrued");
    assert.equal(await perps.read.lastFundingUpdateTime(), block.timestamp);
    const [bids, asks] = await perps.read.getOrderBookPrices([200n]);
    assert.deepEqual([...bids, ...asks], []);
  });
});
