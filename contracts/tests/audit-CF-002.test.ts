import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits } from "viem";
import { deployPerpsFixture } from "./fixtures.ts";
import { TimeInForce } from "../fixtures/timeInForce.ts";

const { networkHelpers } = await network.connect();

/**
 * CF-002 (Critical): fills execute at the maker's price with no band against the oracle
 * mark. 6.8.0 makes a losing *taker* pay in full, but a losing *maker* still takes the
 * bad-debt path, so the maker-loss direction stays open: a short maker rests a far-above-mark
 * reducing bid (cheap, because a deep bid nets its fill-loss reserve away), a colluder sells
 * into it, the maker's loss is written off, and the fund pays the colluder's gain.
 *
 * End-to-end exploit. Setup runs normally; the off-market fill and the extraction are allowed
 * to revert on a fixed venue. The test asserts the safe invariant: the colluding accounts end
 * with no more than they deposited, the fund is not drained, and nothing halts.
 */
describe("CF-002 — an off-market maker fill cannot shift its loss onto the insurance fund", () => {
  it("does not let a colluding pair extract an off-market maker loss from the fund", async () => {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsFixture);
    const { perps, vault, usdcMock } = contracts;
    const { owner, seller: alice, buyer: bob, buyer2: carol } = accounts;
    const unit = (n: string) => parseUnits(n, config.tokenDecimals);
    const Q = parseUnits("100", config.quantityDecimals);

    await perps.write.setTakerFeeBps([0], { account: owner.account });
    await perps.write.setMakerFeeBps([0], { account: owner.account });

    const mark = await perps.read.getMarketPrice();
    const offMarket = parseUnits("140", config.tokenDecimals); // ~3.3x mark, far outside any band
    const deep = config.minimumPriceIncrement; // one-tick bid that only nets the fill-loss reserve

    await usdcMock.write.transfer([alice.account.address, unit("1000")], { account: owner.account });
    const deposits = { alice: unit("1400"), bob: unit("500"), carol: unit("1000") };
    await vault.write.deposit([deposits.alice], { account: alice.account });
    await vault.write.deposit([deposits.bob], { account: bob.account });
    await vault.write.deposit([deposits.carol], { account: carol.account });
    const deposited = deposits.alice + deposits.bob + deposits.carol;

    // Alice opens a short at the mark against Carol.
    await perps.write.createOrder([mark, Q, TimeInForce.GTC], { account: carol.account });
    await perps.write.createOrder([mark, -Q, TimeInForce.IOC], { account: alice.account });
    // Deep bid nets the per-side fill-loss reserve, so the off-market reducing bid rests cheaply.
    // The off-market bid itself is placed inside the attack block: a venue that reserves its
    // full fill loss rejects it, which is a safe outcome.
    await perps.write.createOrder([deep, 3n * Q, TimeInForce.GTC], { account: alice.account });

    const ifBefore = await vault.read.insuranceFundBalance();

    try {
      await perps.write.createOrder([offMarket, Q, TimeInForce.GTC], { account: alice.account });
      // Bob sells into Alice's off-market bid: Alice (maker) realises the loss on the bad-debt path.
      await perps.write.createOrder([offMarket, -Q, TimeInForce.IOC], { account: bob.account });
      // Bob closes at the mark against Carol; the fund pays Bob's off-market gain.
      await perps.write.createOrder([mark, -Q, TimeInForce.GTC], { account: carol.account });
      await perps.write.createOrder([mark, Q, TimeInForce.IOC], { account: bob.account });
    } catch {
      // off-market fill refused — no value moved
    }

    const held =
      (await vault.read.balanceOf([alice.account.address])) +
      (await vault.read.balanceOf([bob.account.address])) +
      (await vault.read.balanceOf([carol.account.address]));
    assert.ok(held <= deposited, "colluding accounts must not end with more than they deposited");
    assert.ok(
      (await vault.read.insuranceFundBalance()) >= ifBefore,
      "insurance fund must not pay out an off-market maker loss",
    );
    assert.equal(await vault.read.halted(), false, "attack must not latch the vault halt");
  });
});
