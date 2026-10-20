import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { maxUint256, parseUnits } from "viem";
import { deployPerpsFixture } from "./fixtures.ts";
import { TimeInForce } from "../fixtures/timeInForce.ts";

const { networkHelpers } = await network.connect();

/**
 * CF-007 (High): the resting-order fill-loss reserve is `max(0, Σvalue − Σqty·mark)` per side,
 * so a deep decoy bid nets away the loss of a bid priced above the mark. Fills go best price
 * first, so the hidden bid fills alone and its maker is left with a loss far above its margin.
 *
 * End-to-end exploits on the real vault + PME + venue. Attack steps may revert on a fixed
 * venue; the tests assert the safe invariant: the colluding accounts end with no more than
 * they deposited, the insurance fund is not drained, and nothing halts.
 */
describe("CF-007 — decoy orders cannot hide a resting order's fill loss", () => {
  async function setup() {
    const fixture = await networkHelpers.loadFixture(deployPerpsFixture);
    const { perps, vault, usdcMock } = fixture.contracts;
    const { owner, seller: alice, buyer: bob, buyer2: carol, seller2: keeper } = fixture.accounts;
    await perps.write.setTakerFeeBps([0], { account: owner.account });
    await perps.write.setMakerFeeBps([0], { account: owner.account });
    await usdcMock.write.transfer([alice.account.address, parseUnits("1000", 6)], { account: owner.account });
    return { ...fixture, alice, bob, carol, keeper };
  }

  type Setup = Awaited<ReturnType<typeof setup>>;

  async function deposit(f: Setup, amounts: { alice: bigint; bob: bigint; carol: bigint }) {
    const { vault } = f.contracts;
    await vault.write.deposit([amounts.alice], { account: f.alice.account });
    await vault.write.deposit([amounts.bob], { account: f.bob.account });
    await vault.write.deposit([amounts.carol], { account: f.carol.account });
    return amounts.alice + amounts.bob + amounts.carol;
  }

  async function liquidateAlice(f: Setup) {
    const { perps } = f.contracts;
    const ids = await perps.read.getUserOrders([f.alice.account.address]);
    if (ids.length > 0) await perps.write.liquidateOrders([f.alice.account.address, ids], { account: f.keeper.account });
    await perps.write.liquidatePosition([f.alice.account.address, maxUint256], { account: f.keeper.account });
  }

  async function assertSafe(f: Setup, deposited: bigint, ifBefore: bigint) {
    const { vault } = f.contracts;
    const held =
      (await vault.read.balanceOf([f.alice.account.address])) +
      (await vault.read.balanceOf([f.bob.account.address])) +
      (await vault.read.balanceOf([f.carol.account.address]));
    assert.ok(held <= deposited, "colluding accounts must not end with more than they deposited");
    assert.ok((await vault.read.insuranceFundBalance()) >= ifBefore, "insurance fund must not pay a hidden loss");
    assert.equal(await vault.read.halted(), false, "attack must not latch the vault halt");
  }

  it("static: a decoy cannot hide a bid resting far above the mark", async () => {
    const f = await setup();
    const { perps, vault } = f.contracts;
    const Q = parseUnits("100", 6);
    const mark = await perps.read.getMarketPrice();
    const high = mark * 2n; // tick-aligned: mark is
    const deep = f.config.minimumPriceIncrement;

    const deposited = await deposit(f, { alice: parseUnits("900", 6), bob: parseUnits("600", 6), carol: parseUnits("1000", 6) });
    await perps.write.createOrder([deep, Q, TimeInForce.GTC], { account: f.alice.account });
    const ifBefore = await vault.read.insuranceFundBalance();

    try {
      await perps.write.createOrder([high, Q, TimeInForce.GTC], { account: f.alice.account });
      await perps.write.createOrder([high, -Q, TimeInForce.IOC], { account: f.bob.account });
      await liquidateAlice(f);
      await perps.write.createOrder([mark, -Q, TimeInForce.GTC], { account: f.carol.account });
      await perps.write.createOrder([mark, Q, TimeInForce.IOC], { account: f.bob.account });
    } catch {
      // attack step rejected — no value moved
    }

    await assertSafe(f, deposited, ifBefore);
  });

  it("patient: decoys cannot hide a resting bid's growing loss from keepers during a slide", async () => {
    const f = await setup();
    const { perps, vault, pme, priceOracle } = f.contracts;
    const Q = parseUnits("100", 6);
    const mark0 = await perps.read.getMarketPrice();
    const deep = f.config.minimumPriceIncrement;

    const deposited = await deposit(f, { alice: parseUnits("1500", 6), bob: parseUnits("600", 6), carol: parseUnits("1000", 6) });
    const ifBefore = await vault.read.insuranceFundBalance();

    try {
      await perps.write.createOrder([mark0, Q, TimeInForce.GTC], { account: f.alice.account });
      await perps.write.createOrder([deep, Q / 2n, TimeInForce.GTC], { account: f.alice.account });
    } catch {
      // placement rejected — no value moved
    }

    // The mark slides 5% per step. A keeper cancels Alice's orders as soon as the engine
    // reports her liquidatable.
    let price = f.config.oracle.price;
    for (let step = 0; step < 12; step++) {
      price = (price * 95n) / 100n;
      await priceOracle.write.setPrice([price, f.config.oracle.decimals]);
      if (await pme.read.isLiquidatable([f.alice.account.address])) {
        const ids = await perps.read.getUserOrders([f.alice.account.address]);
        if (ids.length > 0) {
          await perps.write.liquidateOrders([f.alice.account.address, ids], { account: f.keeper.account });
        }
      }
    }

    try {
      const mark = await perps.read.getMarketPrice();
      await perps.write.createOrder([mark0, -Q, TimeInForce.IOC], { account: f.bob.account });
      await liquidateAlice(f);
      await perps.write.createOrder([mark, -Q, TimeInForce.GTC], { account: f.carol.account });
      await perps.write.createOrder([mark, Q, TimeInForce.IOC], { account: f.bob.account });
    } catch {
      // stale bid already cancelled by the keeper — no value moved
    }

    await assertSafe(f, deposited, ifBefore);
  });
});
