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
const WAD = 10n ** 18n;

/** Drift funding (N25): perps pays holders the mark's scheduled decline along the glide. */
async function driftFixture(perpsFeed: "index" | "glide", startOffset = 1n) {
  const data = await deployPerpsFixture(conn);
  const { perps, pme, vault } = data.contracts;
  const { owner, buyer: alice, seller: bob } = data.accounts;
  await perps.write.setMakerFeeBps([0], { account: owner.account });
  await perps.write.setTakerFeeBps([0], { account: owner.account });

  const btc = await viem.deployContract("HashpriceBTCMock", []);
  const btcUsd = await viem.deployContract("PriceOracleMock", [BTC_USD, 8]);
  const hashpriceUSD = await viem.deployContract("HashpriceUSD", [btc.address, btcUsd.address]);
  const glideUSD = await viem.deployContract("HashpriceGlideUSD", [hashpriceUSD.address]);
  const halving = 5n * (await glideUSD.read.HALVING_INTERVAL());
  const glideBlocks = await glideUSD.read.GLIDE_BLOCKS();
  const glideStart = halving - glideBlocks - (await glideUSD.read.GLIDE_END_BLOCKS());
  const relay = (height: bigint) => btc.write.setBlock([Number(height), FEES, DIFFICULTY]);
  await relay(glideStart - startOffset);

  await pme.write.setOracle([hashpriceUSD.address]);
  await perps.write.setOracle([perpsFeed === "glide" ? glideUSD.address : hashpriceUSD.address]);
  await pme.write.setShocks([(15n * WAD) / 100n, (10n * WAD) / 100n, await pme.read.imVolShock(), await pme.read.mmVolShock()]);

  const qty = parseUnits("100", data.config.quantityDecimals);
  const deposit = parseUnits("1000", data.config.tokenDecimals);
  await vault.write.deposit([deposit], { account: alice.account });
  await vault.write.deposit([deposit], { account: bob.account });
  const entry = await perps.read.getMarketPrice();
  await perps.write.createOrder([entry, -qty, TimeInForce.GTC], { account: bob.account });
  await perps.write.createOrder([entry, qty, TimeInForce.GTC], { account: alice.account });

  return { ...data, btc, hashpriceUSD, glideUSD, halving, glideStart, glideBlocks, relay, qty, deposit, entry };
}

describe("Perps drift funding (N25)", function () {
  it("a long and a short held through the glide and the halving each get their money back on closing", async function () {
    const s = await driftFixture("glide");
    const { perps, vault } = s.contracts;
    const { buyer: alice, seller: bob, buyer2: keeper } = s.accounts;
    const fundBefore = await vault.read.insuranceFundBalance();

    // One write half way through the glide: drift accrues and folds on the next settle.
    await s.relay(s.glideStart + s.glideBlocks / 2n);
    await perps.write.updateFunding({ account: keeper.account });
    assert.ok((await perps.read.cumulativeDriftPerUnit()) > 0n, "longs are owed drift half way through");
    assert.ok((await perps.read.getPendingDrift([alice.account.address])) > 0n);
    assert.ok((await perps.read.getPendingDrift([bob.account.address])) < 0n);

    await s.relay(s.halving);
    const exit = await perps.read.getMarketPrice();
    assert.ok(exit * 100n < s.entry * 55n, "the index has stepped down");
    await perps.write.createOrder([exit, s.qty, TimeInForce.GTC], { account: bob.account });
    await perps.write.createOrder([exit, -s.qty, TimeInForce.GTC], { account: alice.account });

    assert.equal((await perps.read.getUserPosition([alice.account.address])).netQuantity, 0n);
    // The mark fell about 49.5% and drift paid it back: both sides end where they started, up to
    // rounding to the price tick (0.005 per contract) and drift's integer division.
    const tolerance = parseUnits("1", 6);
    for (const who of [alice, bob]) {
      const balance = await vault.read.balanceOf([who.account.address]);
      const diff = balance > s.deposit ? balance - s.deposit : s.deposit - balance;
      assert.ok(diff <= tolerance, `${who.account.address} ended ${balance} against ${s.deposit}`);
    }
    const fundDiff = (await vault.read.insuranceFundBalance()) - fundBefore;
    assert.ok(fundDiff <= tolerance && -fundDiff <= tolerance, `insurance fund moved by ${fundDiff}`);
  });

  it("a feed without a schedule pays no drift", async function () {
    const s = await driftFixture("index");
    const { perps } = s.contracts;
    await s.relay(s.glideStart + s.glideBlocks / 2n);
    await perps.write.updateFunding({ account: s.accounts.buyer2.account });
    assert.equal(await perps.read.cumulativeDriftPerUnit(), 0n);
    assert.equal(await perps.read.getPendingDrift([s.accounts.buyer.account.address]), 0n);
  });

  it("switching to the glide feed mid-glide pays nothing for the part already past", async function () {
    const s = await driftFixture("index");
    const { perps } = s.contracts;
    await s.relay(s.glideStart + s.glideBlocks / 2n);
    await perps.write.setOracle([s.glideUSD.address], { account: s.accounts.owner.account });
    assert.equal(await perps.read.getPendingDrift([s.accounts.buyer.account.address]), 0n);

    await s.relay(s.glideStart + s.glideBlocks / 2n + 1n);
    assert.ok((await perps.read.getPendingDrift([s.accounts.buyer.account.address])) > 0n, "drift from the switch on");
  });
});
