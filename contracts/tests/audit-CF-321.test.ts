import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { maxUint256, parseUnits } from "viem";
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
const DAY = 86_400n;
const WAD = 10n ** 18n;

/**
 * The 2028 halving on the real oracle chain: `HashpriceBTCMock` (any Bitcoin height) →
 * `HashpriceUSD` → `HashpriceGlideUSD`. The engine reads the raw index; perps reads
 * `perpsFeed`. A colluding pair trades: Alice long, Bob short, Alice keeping only IM. A keeper
 * liquidates Alice whenever she is liquidatable and tries to unwind the backstop.
 */
async function halvingFixture(perpsFeed: "index" | "glide") {
  const data = await deployPerpsFixture(conn);
  const { perps, pme, vault } = data.contracts;
  const { owner, buyer: alice, seller: bob, buyer2: keeper } = data.accounts;

  await perps.write.setLiquidationFeeBps([0], { account: owner.account });
  await perps.write.setMakerFeeBps([0], { account: owner.account });
  await perps.write.setTakerFeeBps([0], { account: owner.account });

  const btc = await viem.deployContract("HashpriceBTCMock", []);
  const btcUsd = await viem.deployContract("PriceOracleMock", [BTC_USD, BTC_USD_DECIMALS]);
  const hashpriceUSD = await viem.deployContract("HashpriceUSD", [btc.address, btcUsd.address]);
  const glideUSD = await viem.deployContract("HashpriceGlideUSD", [hashpriceUSD.address]);

  const interval = await glideUSD.read.HALVING_INTERVAL();
  const glideBlocks = await glideUSD.read.GLIDE_BLOCKS();
  const glideEndBlocks = await glideUSD.read.GLIDE_END_BLOCKS();
  const halving = 5n * interval; // 1,050,000
  const glideStart = halving - glideBlocks - glideEndBlocks;
  const relay = (height: bigint) => btc.write.setBlock([Number(height), FEES, DIFFICULTY]);
  await relay(glideStart - 1n);

  await pme.write.setOracle([hashpriceUSD.address]);
  await perps.write.setOracle([perpsFeed === "glide" ? glideUSD.address : hashpriceUSD.address]);
  // IM 15% / MM 10% spot shocks, the production levels; vol shocks unchanged.
  await pme.write.setShocks([
    (15n * WAD) / 100n,
    (10n * WAD) / 100n,
    await pme.read.imVolShock(),
    await pme.read.mmVolShock(),
  ]);

  // 100 contracts, about $4,200 at the index.
  const qty = parseUnits("100", data.config.quantityDecimals);
  const mark = await perps.read.getMarketPrice();
  await vault.write.deposit([parseUnits("1000", data.config.tokenDecimals)], { account: alice.account });
  await vault.write.deposit([parseUnits("1000", data.config.tokenDecimals)], { account: bob.account });
  await perps.write.createOrder([mark, -qty, TimeInForce.GTC], { account: bob.account });
  await perps.write.createOrder([mark, qty, TimeInForce.GTC], { account: alice.account });

  // Alice keeps exactly her initial margin.
  const im = await pme.read.computePortfolioIM([alice.account.address]);
  const balance = await vault.read.balanceOf([alice.account.address]);
  await vault.write.withdraw([balance - im], { account: alice.account });

  const backstop = await perps.read.BACKSTOP();

  /** Vault balance plus mark PnL less funding owed; an unpayable debt is not the account's. */
  async function equity(who: `0x${string}`) {
    const view = await perps.read.getRiskView([who]);
    return (await vault.read.balanceOf([who])) + view.unrealizedPnl - view.pendingFunding;
  }
  const pairBefore = (await equity(alice.account.address)) + (await equity(bob.account.address));

  async function keeperPass() {
    if (await pme.read.isLiquidatable([alice.account.address])) {
      const position = await perps.read.getUserPosition([alice.account.address]);
      if (position.netQuantity !== 0n) {
        await perps.write.liquidatePosition([alice.account.address, maxUint256], { account: keeper.account });
      }
    }
    if ((await perps.read.getUserPosition([backstop])).netQuantity !== 0n) {
      try {
        await perps.write.unwindBackstop([maxUint256], { account: keeper.account });
      } catch {
        // Nothing inside the band to fill.
      }
    }
  }

  /** What the pair made, all of it paid by the insurance fund or the backstop (fees are 0). */
  async function protocolLoss() {
    return (await equity(alice.account.address)) + (await equity(bob.account.address)) - pairBefore;
  }

  return { ...data, btc, glideUSD, hashpriceUSD, halving, glideStart, relay, keeperPass, protocolLoss, qty, mark };
}

describe("CF-321 — a colluding pair across the halving", function () {
  it("perps on the raw index (today): the pair takes the halving step beyond the margin from the protocol", async function () {
    const s = await halvingFixture("index");
    await s.relay(s.halving);
    await s.keeperPass();
    const loss = await s.protocolLoss();
    const value = (s.mark * s.qty) / 10n ** 6n;
    console.log(`    index feed: protocol loss ${loss} (token units), position value at entry ${value}`);
    // The step is about 49.5% and Alice held 15%: the protocol pays about a third of the position.
    assert.ok(loss * 100n > value * 30n, `the protocol paid ${loss} of ${value}`);
  });

  it("perps on the glide: liquidated a day at a time, the protocol pays nothing", async function () {
    const s = await halvingFixture("glide");
    const { time } = networkHelpers;
    const step = await s.glideUSD.read.GLIDE_END_BLOCKS();
    let liquidatedAt: bigint | undefined;
    for (let height = s.glideStart; height < s.halving; height += step) {
      await time.increase(DAY);
      await s.relay(height);
      await s.keeperPass();
      if (liquidatedAt === undefined) {
        const position = await s.contracts.perps.read.getUserPosition([s.accounts.buyer.account.address]);
        if (position.netQuantity === 0n) liquidatedAt = height;
      }
    }
    await time.increase(DAY);
    await s.relay(s.halving);
    await s.keeperPass();
    const loss = await s.protocolLoss();
    const backstop = await s.contracts.perps.read.getUserPosition([await s.contracts.perps.read.BACKSTOP()]);
    console.log(
      `    glide feed: Alice liquidated at ${liquidatedAt} (${liquidatedAt === undefined ? "-" : s.halving - liquidatedAt} blocks before the halving), backstop holds ${backstop.netQuantity}, protocol loss ${loss}`,
    );
    assert.equal(loss, 0n, "the protocol pays for the halving");
  });
});
