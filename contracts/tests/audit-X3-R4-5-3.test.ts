import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits } from "viem";
import { deployPerpsFixture } from "./fixtures.ts";
import { TimeInForce } from "../fixtures/timeInForce.ts";

const { networkHelpers } = await network.connect();

/**
 * X3-R4-5-3: `forceClosePositions` realized each listed position against the insurance fund
 * with no backstop hand-off, so closing a subset left `Σ(users) + backstop ≠ 0` and the fund
 * holding an untracked position.
 */
describe("X3-R4-5-3 — perps force-close hands the closed size to the backstop", () => {
  it("keeps users plus backstop summing to zero when only one side is closed", async () => {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsFixture);
    const { perps, vault } = contracts;
    const { owner, seller, buyer } = accounts;

    await perps.write.setMakerFeeBps([0], { account: owner.account });
    await perps.write.setTakerFeeBps([0], { account: owner.account });
    const entry = await perps.read.getMarketPrice();
    const qty = parseUnits("40", config.quantityDecimals);
    await vault.write.deposit([entry * 20n], { account: seller.account });
    await vault.write.deposit([entry * 20n], { account: buyer.account });
    await perps.write.createOrder([entry, -qty, TimeInForce.GTC], { account: seller.account });
    await perps.write.createOrder([entry, qty, TimeInForce.GTC], { account: buyer.account });

    await vault.write.halt({ account: owner.account });
    await perps.write.forceClosePositions([[buyer.account.address]], { account: owner.account });

    const backstop = await perps.read.BACKSTOP();
    let sum = 0n;
    for (const who of [seller.account.address, buyer.account.address, backstop]) {
      sum += (await perps.read.getUserPosition([who])).netQuantity;
    }
    assert.equal((await perps.read.getUserPosition([buyer.account.address])).netQuantity, 0n);
    assert.equal(sum, 0n, "seller's short is left facing nothing");
    assert.equal((await perps.read.getUserPosition([backstop])).netQuantity, qty);
  });
});
