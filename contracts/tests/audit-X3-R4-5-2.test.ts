import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits } from "viem";
import { deployPerpsFixture } from "./fixtures.ts";
import { TimeInForce } from "../fixtures/timeInForce.ts";

const { networkHelpers } = await network.connect();

/**
 * X3-R4-5-2: a vault halt must stop every fill. `unwindBackstop` skipped the halt check, so
 * during a halt it matched a user's resting order and opened a position the user could not
 * reduce (createOrder reverts `TradingHalted`) while liquidations stayed live.
 */
describe("X3-R4-5-2 — perps backstop unwind opens no user position while halted", () => {
  it("leaves a resting order unfilled while the vault is halted", async () => {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsFixture);
    const { perps, priceOracle, vault } = contracts;
    const { owner, seller, buyer, buyer2, seller2: carol } = accounts;

    await perps.write.setLiquidationFeeBps([0], { account: owner.account });
    await perps.write.setMakerFeeBps([0], { account: owner.account });
    await perps.write.setTakerFeeBps([0], { account: owner.account });

    const entry = await perps.read.getMarketPrice();
    const qty = parseUnits("40", config.quantityDecimals);
    const one = parseUnits("1", config.quantityDecimals);
    await vault.write.deposit([entry * 13n], { account: seller.account });
    await vault.write.deposit([entry * 20n], { account: buyer.account });
    await vault.write.deposit([entry * 20n], { account: buyer2.account });
    await vault.write.deposit([entry * 20n], { account: carol.account });
    await perps.write.createOrder([entry, -qty, TimeInForce.GTC], { account: seller.account });
    await perps.write.createOrder([entry, qty, TimeInForce.GTC], { account: buyer.account });

    // +30% pump liquidates the seller; the backstop inherits the short.
    await priceOracle.write.setPrice([(entry * 13n) / 10n, config.oracle.decimals]);
    await perps.write.liquidatePosition([seller.account.address, qty], { account: buyer2.account });
    const backstop = await perps.read.BACKSTOP();
    assert.equal((await perps.read.getUserPosition([backstop])).netQuantity, -qty);

    // Flat carol rests an ask at the mark, inside the unwind band; then the vault halts.
    const mark = await perps.read.getMarketPrice();
    await perps.write.createOrder([mark, -one, TimeInForce.GTC], { account: carol.account });
    await vault.write.halt({ account: owner.account });

    try {
      await perps.write.unwindBackstop([one], { account: buyer2.account });
    } catch {}

    assert.equal(
      (await perps.read.getUserPosition([carol.account.address])).netQuantity,
      0n,
      "halt-time unwind opened a position carol cannot reduce",
    );
    assert.equal((await perps.read.getUserPosition([backstop])).netQuantity, -qty);
  });
});
