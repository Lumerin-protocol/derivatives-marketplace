import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { maxInt256, parseUnits } from "viem";
import { deployPerpsWithFundingFixture } from "./fixtures.ts";
import { TimeInForce } from "../fixtures/timeInForce.ts";

const { networkHelpers } = await network.connect();

/**
 * CF-012 (High): order price has no upper bound, and funding computes
 * `(mark - index) * 10^FUNDING_DECIMALS` from the book mid with checked math. One dust ask at
 * about 1.2e59 makes that product overflow from the next block on, so every entry point that
 * accrues funding first (orders, cancels, liquidations, `updateFunding`) and every PME read
 * through `getRiskView` reverts until the owner intervenes.
 *
 * The attack is run in full; the test asserts that perps keeps working afterwards. On the
 * unfixed venue the ask rests and these calls revert; once oversized prices are rejected at
 * placement the attack cannot start.
 */
describe("CF-012 — an extreme ask cannot overflow funding and freeze perps", () => {
  const POISON_PRICE = 12n * 10n ** 58n; // audit PoC price, tick-aligned
  const UNIT = 1n; // 1e-6 contract, so the ask needs almost no margin

  it("keeps funding, cancels, margin reads and withdrawals working", async () => {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithFundingFixture);
    const { perps, vault, pme } = contracts;
    const { seller, buyer } = accounts;

    const mark = await perps.read.getMarketPrice();
    const tick = config.minimumPriceIncrement;
    assert.equal(POISON_PRICE % tick, 0n, "poison price is tick-aligned");
    assert.ok(
      (POISON_PRICE + mark - tick) / 2n - mark > maxInt256 / 10n ** BigInt(config.fundingDecimals),
      "poison mid overflows the funding rate product",
    );

    // Honest resting bid makes the book two-sided.
    await perps.write.createOrder([mark - tick, parseUnits("1", config.quantityDecimals), TimeInForce.GTC], {
      account: buyer.account,
    });
    const [bidId] = await perps.read.getUserOrders([buyer.account.address]);

    try {
      await perps.write.createOrder([POISON_PRICE, -UNIT, TimeInForce.GTC], { account: seller.account });
    } catch {
      // placement rejected — the attack never started
    }

    await networkHelpers.time.increase(3600);

    await assert.doesNotReject(perps.write.updateFunding(), "funding accrual must not revert");
    await assert.doesNotReject(pme.read.computePortfolioMM([buyer.account.address]), "PME reads must not revert");
    await assert.doesNotReject(
      vault.write.withdraw([parseUnits("1", config.tokenDecimals)], { account: buyer.account }),
      "withdrawals must not revert",
    );
    await assert.doesNotReject(
      perps.write.cancelOrder([bidId], { account: buyer.account }),
      "cancels must not revert",
    );
  });
});
