import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits } from "viem";
import { deployPerpsFixture } from "./fixtures.ts";
import { TimeInForce } from "../fixtures/timeInForce.ts";

const conn = await network.connect();
const { viem, networkHelpers } = conn;

/** Fee average at the 2026 level: a halving step of about 49.5%. */
const FEES = 3_150_000n;
/** About 150 T. */
const DIFFICULTY = 150_000_000_000_000n;
/** BTC/USD $100,000 (8 decimals): with the values above the index is about $42 per PH/s/day. */
const BTC_USD = 10_000_000_000_000n;
const BTC_USD_DECIMALS = 8;
const WAD = 10n ** 18n;

/**
 * Perps on `HashpriceGlideUSD` at the end of the glide (about 0.505 × the index), the engine on
 * the index. Alice is short 100 contracts priced at the index on a second venue (a pre-halving
 * futures date) and holds nothing else.
 */
async function spreadFixture() {
  const data = await deployPerpsFixture(conn);
  const { perps, pme, vault } = data.contracts;
  const { owner, buyer: alice, seller: bob } = data.accounts;

  await perps.write.setMakerFeeBps([0], { account: owner.account });
  await perps.write.setTakerFeeBps([0], { account: owner.account });

  const btc = await viem.deployContract("HashpriceBTCMock", []);
  const btcUsd = await viem.deployContract("PriceOracleMock", [BTC_USD, BTC_USD_DECIMALS]);
  const hashpriceUSD = await viem.deployContract("HashpriceUSD", [btc.address, btcUsd.address]);
  const glideUSD = await viem.deployContract("HashpriceGlideUSD", [hashpriceUSD.address]);
  const halving = 5n * (await glideUSD.read.HALVING_INTERVAL()); // 1,050,000
  await btc.write.setBlock([Number(halving - (await glideUSD.read.GLIDE_END_BLOCKS())), FEES, DIFFICULTY]);

  await pme.write.setOracle([hashpriceUSD.address]);
  await perps.write.setOracle([glideUSD.address]);
  // IM 15% / MM 10% spot shocks, the production levels; vol shocks unchanged.
  await pme.write.setShocks([
    (15n * WAD) / 100n,
    (10n * WAD) / 100n,
    await pme.read.imVolShock(),
    await pme.read.mmVolShock(),
  ]);

  const qty = parseUnits("100", data.config.quantityDecimals);
  const contractScale = 10n ** BigInt(data.config.quantityDecimals);
  const [, indexAnswer] = await hashpriceUSD.read.latestRoundData();
  const index = (indexAnswer * 10n ** BigInt(data.config.tokenDecimals)) / 10n ** BigInt(await hashpriceUSD.read.decimals());
  const glide = await perps.read.getMarketPrice();
  assert.ok(glide * 100n < index * 55n, "the fixture sits at the end of the glide");

  const otherVenue = await viem.deployContract("PerpsDEXMock", []);
  await otherVenue.write.setVault([vault.address]);
  await otherVenue.write.setUserPosition([alice.account.address, -qty, index]);
  await pme.write.addLinearMarket([otherVenue.address]);

  const deposit = parseUnits("1000", data.config.tokenDecimals);
  await vault.write.deposit([deposit], { account: alice.account });
  await vault.write.deposit([deposit], { account: bob.account });

  /** Alice's account value: vault balance plus both venues' mark PnL, less funding owed. */
  async function equity() {
    const perpsView = await perps.read.getRiskView([alice.account.address]);
    const otherView = await otherVenue.read.getRiskView([alice.account.address]);
    return (
      (await vault.read.balanceOf([alice.account.address])) +
      perpsView.unrealizedPnl -
      perpsView.pendingFunding +
      otherView.unrealizedPnl
    );
  }

  /** Moves the index by `num / den` through BTC/USD and marks the short on the other venue. */
  async function moveIndex(num: bigint, den: bigint) {
    await btcUsd.write.setPrice([(BTC_USD * num) / den, BTC_USD_DECIMALS]);
    const [, moved] = await hashpriceUSD.read.latestRoundData();
    const movedIndex = (moved * 10n ** BigInt(data.config.tokenDecimals)) / 10n ** BigInt(await hashpriceUSD.read.decimals());
    await otherVenue.write.setUnrealizedPnl([alice.account.address, (-(movedIndex - index) * qty) / contractScale]);
  }

  return { ...data, otherVenue, glideUSD, hashpriceUSD, qty, contractScale, index, glide, equity, moveIndex };
}

describe("CF-321 — perps deltas scaled by glide / index", function () {
  it("a perps long against a short at the index, kept at IM, survives a move of the MM shock", async function () {
    const s = await networkHelpers.loadFixture(spreadFixture);
    const { perps, pme, vault } = s.contracts;
    const { buyer: alice, seller: bob } = s.accounts;

    await perps.write.createOrder([s.glide, -s.qty, TimeInForce.GTC], { account: bob.account });
    await perps.write.createOrder([s.glide, s.qty, TimeInForce.GTC], { account: alice.account });

    // Alice withdraws down to her initial margin.
    const im = await pme.read.computePortfolioIM([alice.account.address]);
    const balance = await vault.read.balanceOf([alice.account.address]);
    if (balance > im) await vault.write.withdraw([balance - im], { account: alice.account });

    const mmShock = await pme.read.mmSpotShock();
    await s.moveIndex(WAD + mmShock, WAD);

    const after = await s.equity();
    console.log(`    IM ${im}, equity after a +${(mmShock * 100n) / WAD}% index move ${after}`);
    assert.ok(after >= 0n, `the spread ends under water: equity ${after}`);
  });

  it("a resting perps bid that would open that spread reserves the IM of the filled position", async function () {
    const s = await networkHelpers.loadFixture(spreadFixture);
    const { perps, pme } = s.contracts;
    const { buyer: alice } = s.accounts;

    await perps.write.createOrder([s.glide, s.qty, TimeInForce.GTC], { account: alice.account });
    const withOrder = await pme.read.computePortfolioIM([alice.account.address]);

    // The filled spread's real exposure: short 100 at the index, long 100 at the glide.
    const exposure = ((s.index - s.glide) * s.qty) / s.contractScale;
    const required = (exposure * (await pme.read.imSpotShock())) / WAD;
    console.log(`    IM with the bid resting ${withOrder}, IM of the real exposure ${required}`);
    assert.ok(withOrder * 100n >= required * 99n, `resting bid reserves ${withOrder}, real exposure needs ${required}`);
  });
});
