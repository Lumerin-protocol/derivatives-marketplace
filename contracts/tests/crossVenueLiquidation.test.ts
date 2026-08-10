import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { maxUint256 } from "viem";
import { deployPerpsWithLiquidatablePositionFixture } from "./fixtures.ts";

const { viem, networkHelpers } = await network.connect();

/**
 * Resting order delta on the *other* venue, in the shared 10^collateralDecimals
 * delta scale. Sized well above the seller's 1-unit short so the bid leg stays
 * the binding one both before and after the short is closed.
 */
const OTHER_VENUE_BID_DELTA = 21_000_000n;

/**
 * Register a second linear market on the PME carrying resting bid delta for
 * `user`. `PerpsDEXMock` is just an `ILinearMarket`; the name is incidental —
 * what matters is that it is a venue the perps DEX cannot see the book of.
 */
async function addOtherVenue(
  pme: { write: { addLinearMarket: (args: [`0x${string}`]) => Promise<unknown> } },
  vaultAddress: `0x${string}`,
  user: `0x${string}`,
  netPositionDelta: bigint,
) {
  const otherVenue = await viem.deployContract("PerpsDEXMock", []);
  await otherVenue.write.setVault([vaultAddress]);
  await otherVenue.write.setUserPosition([user, netPositionDelta, 0n]);
  await otherVenue.write.setOrderDeltas([user, OTHER_VENUE_BID_DELTA, 0n]);
  await pme.write.addLinearMarket([otherVenue.address]);
  return otherVenue;
}

/**
 * Each venue's `liquidatePosition` gates on `participantOrderIdsIndex` — its own
 * book. Margin is portfolio-level, so that scope is too narrow: a short position
 * on one venue offsets resting bids on another, and closing the short leaves the
 * bid leg unopposed. Liquidation then *raises* the requirement it was meant to
 * relieve.
 */
describe("HashPowerPerpsDEX - cross-venue liquidation", function () {
  it("rejects a locally reducing order that increases portfolio IM", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithLiquidatablePositionFixture,
    );
    const { perps, pme, vault } = contracts;
    const { seller } = accounts;
    const sellerAddr = seller.account.address;

    // The real DEX position is short 1; a long 2 position elsewhere makes the
    // portfolio net long 1. A local buy looks reducing here but would move the
    // portfolio's all-bids-fill endpoint to long 2.
    const otherVenue = await viem.deployContract("PerpsDEXMock", []);
    await otherVenue.write.setVault([vault.address]);
    await otherVenue.write.setUserPosition([sellerAddr, 2_000_000n, 0n]);
    await pme.write.addLinearMarket([otherVenue.address]);

    const imBefore = await pme.read.computePortfolioIM([sellerAddr]);
    const balance = await vault.read.balanceOf([sellerAddr]);
    assert.ok(balance >= imBefore, "fixture must cover the pre-order portfolio IM");

    await viem.assertions.revertWithCustomError(
      perps.write.createOrder(
        [config.initialPrice - config.minimumPriceIncrement, config.qty, 0],
        { account: seller.account },
      ),
      perps,
      "InsufficientMarginBalance",
    );
  });

  it("closing position delta raises the requirement when opposite-side orders rest elsewhere", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(
      deployPerpsWithLiquidatablePositionFixture,
    );
    const { pme, vault } = contracts;
    const { seller } = accounts;
    const sellerAddr = seller.account.address;

    // A 1-unit short on the other venue, against 21 units of resting bids there.
    const otherVenue = await addOtherVenue(pme, vault.address, sellerAddr, -1_000_000n);

    const mmWithPosition = await pme.read.computePortfolioMM([sellerAddr]);

    // Close the short, changing nothing else. The bid leg loses its offset.
    await otherVenue.write.setUserPosition([sellerAddr, 0n, 0n]);
    const mmFlat = await pme.read.computePortfolioMM([sellerAddr]);

    assert.ok(
      mmFlat > mmWithPosition,
      `closing the short must raise MM (${mmWithPosition} -> ${mmFlat}): the short was ` +
        "offsetting the resting bids, so removing it widens the worst leg",
    );
  });

  it("refuses to close a position while the portfolio has resting orders on another venue", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(
      deployPerpsWithLiquidatablePositionFixture,
    );
    const { perps, pme, vault } = contracts;
    const { seller, buyer2 } = accounts;
    const sellerAddr = seller.account.address;

    // The seller is short on the real DEX and has no resting orders *here*, so the
    // local orders-first gate is satisfied. The bids rest on the other venue.
    await addOtherVenue(pme, vault.address, sellerAddr, 0n);

    assert.equal(
      (await perps.read.getUserOrders([sellerAddr])).length,
      0,
      "local book is empty — the local gate cannot catch this",
    );
    assert.ok(
      await perps.read.isLiquidatable([sellerAddr]),
      "order delta alone puts the account under MM",
    );

    await viem.assertions.revertWithCustomError(
      perps.write.liquidatePosition([sellerAddr, maxUint256], { account: buyer2.account }),
      perps,
      "OrdersStillOpen",
    );
  });
});
