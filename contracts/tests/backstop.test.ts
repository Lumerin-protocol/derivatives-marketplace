import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, parseEventLogs, parseUnits, zeroHash } from "viem";
import type { NetworkConnection } from "hardhat/types/network";
import { deployPerpsFixture } from "./fixtures.ts";
import { TimeInForce } from "../fixtures/timeInForce.ts";

const { viem, networkHelpers } = await network.connect();

const BPS = 10_000n;

/**
 * Protocol backstop on perps: liquidation hands the closed quantity to `BACKSTOP` as an
 * explicit position and anyone can shrink it through `unwindBackstop`.
 *
 * Fixture mirrors liquidate-partial.test.ts: seller short 40 vs buyer long 40 at the mark,
 * PME default 10% IM / 5% MM. A +30% pump makes the seller liquidatable. `buyer2` is a
 * funded third party used as liquidator / unwind caller / counter-liquidity.
 */
async function backstopFixture(_conn: NetworkConnection) {
  const data = await networkHelpers.loadFixture(deployPerpsFixture);
  const { contracts, accounts, config } = data;
  const { perps, priceOracle, vault } = contracts;
  const { seller, buyer, buyer2, owner } = accounts;

  await perps.write.setLiquidationFeeBps([0], { account: owner.account });
  await perps.write.setMakerFeeBps([0], { account: owner.account });
  await perps.write.setTakerFeeBps([0], { account: owner.account });

  const entry = await perps.read.getMarketPrice();
  const qty = parseUnits("40", config.quantityDecimals);
  const one = parseUnits("1", config.quantityDecimals);

  await vault.write.deposit([entry * 13n], { account: seller.account });
  await vault.write.deposit([entry * 20n], { account: buyer.account });
  await vault.write.deposit([entry * 20n], { account: buyer2.account });

  await perps.write.createOrder([entry, -qty, TimeInForce.GTC], { account: seller.account });
  await perps.write.createOrder([entry, qty, TimeInForce.GTC], { account: buyer.account });

  const backstop = await perps.read.BACKSTOP();
  const users = [seller.account.address, buyer.account.address, buyer2.account.address, backstop];

  return {
    ...data,
    backstop,
    config: { ...config, entry, qty, one },
    async pump(num: bigint, den: bigint) {
      const mark = (entry * num) / den;
      await priceOracle.write.setPrice([mark, config.oracle.decimals]);
      return mark;
    },
    async netSum() {
      let sum = 0n;
      for (const who of users) sum += (await perps.read.getUserPosition([who])).netQuantity;
      return sum;
    },
    /** +30% pump then a full liquidation of the seller: the backstop ends up short `qty`. */
    async handOffAll() {
      const mark = await this.pump(13n, 10n);
      await perps.write.liquidatePosition([seller.account.address, qty], { account: buyer2.account });
      return mark;
    },
    value(price: bigint, abs: bigint) {
      return (price * abs) / 10n ** BigInt(config.quantityDecimals);
    },
  };
}

describe("HashPowerPerpsDEX - protocol backstop", function () {
  it("exposes the vault's backstop vanity address", async function () {
    const data = await networkHelpers.loadFixture(backstopFixture);
    assert.equal(getAddress(data.backstop), getAddress(await data.contracts.vault.read.BACKSTOP_ADDR()));
  });

  describe("liquidation hand-off", function () {
    it("partial close gives the backstop the liquidated side at the mark and conserves net", async function () {
      const data = await networkHelpers.loadFixture(backstopFixture);
      const { perps } = data.contracts;
      const { seller, buyer, buyer2, pc } = data.accounts;
      const { qty } = data.config;

      assert.equal(await data.netSum(), 0n);
      const mark = await data.pump(13n, 10n);
      const closeQty = parseUnits("30", data.config.quantityDecimals);
      const hash = await perps.write.liquidatePosition([seller.account.address, closeQty], {
        account: buyer2.account,
      });
      const receipt = await pc.waitForTransactionReceipt({ hash });

      const backstopPos = await perps.read.getUserPosition([data.backstop]);
      assert.equal(backstopPos.netQuantity, -closeQty, "backstop inherits the short");
      assert.equal(backstopPos.netEntryValue, -data.value(mark, closeQty));
      assert.equal((await perps.read.getUserPosition([seller.account.address])).netQuantity, -(qty - closeQty));
      assert.equal((await perps.read.getUserPosition([buyer.account.address])).netQuantity, qty, "counterparty untouched");
      assert.equal(await data.netSum(), 0n);

      const [assigned] = parseEventLogs({ logs: receipt.logs, abi: perps.abi, eventName: "BackstopAssigned" });
      assert.equal(getAddress(assigned.args.user), getAddress(seller.account.address));
      assert.equal(assigned.args.quantity, -closeQty);
      assert.equal(assigned.args.price, mark);
    });

    it("full close moves the whole position without touching backstop collateral", async function () {
      const data = await networkHelpers.loadFixture(backstopFixture);
      const { perps, vault } = data.contracts;
      const { seller } = data.accounts;
      const { qty } = data.config;

      const mark = await data.handOffAll();
      const backstopPos = await perps.read.getUserPosition([data.backstop]);
      assert.equal(backstopPos.netQuantity, -qty);
      assert.equal(backstopPos.netEntryValue, -data.value(mark, qty));
      assert.equal((await perps.read.getUserPosition([seller.account.address])).netQuantity, 0n);
      assert.equal(await vault.read.balanceOf([data.backstop]), 0n);
      assert.equal(await data.netSum(), 0n);
    });

    it("an opposite hand-off nets against the backstop's existing position", async function () {
      const data = await networkHelpers.loadFixture(backstopFixture);
      const { perps, vault, pme } = data.contracts;
      const { buyer, buyer2 } = data.accounts;
      const { qty } = data.config;

      await data.handOffAll(); // backstop short 40
      // Thin the buyer's collateral, then dump so the long becomes liquidatable.
      const bal = await vault.read.balanceOf([buyer.account.address]);
      await vault.write.withdraw([bal - data.config.entry * 6n], { account: buyer.account });
      await data.pump(6n, 10n);
      assert.ok(await pme.read.isLiquidatable([buyer.account.address]));

      const closeQty = parseUnits("15", data.config.quantityDecimals);
      await perps.write.liquidatePosition([buyer.account.address, closeQty], { account: buyer2.account });

      assert.equal((await perps.read.getUserPosition([data.backstop])).netQuantity, -(qty - closeQty));
      assert.equal(await data.netSum(), 0n);
    });

    it("the backstop accrues funding on its inherited size and settles it on unwind", async function () {
      const data = await networkHelpers.loadFixture(backstopFixture);
      const { perps, vault } = data.contracts;
      const { owner, buyer2, seller2, pc } = data.accounts;
      const { one, minimumPriceIncrement: tick } = data.config;

      await perps.write.setFundingParameters([100n, 86400n], { account: owner.account });
      await data.handOffAll(); // backstop short 40; snapshot taken at hand-off
      const mark = await perps.read.getMarketPrice();

      // Two-sided book with mid above index: longs pay shorts, so the backstop is owed.
      await vault.write.deposit([data.config.entry * 20n], { account: seller2.account });
      await perps.write.createOrder([mark + tick, one, TimeInForce.GTC], { account: buyer2.account });
      await perps.write.createOrder([mark + 3n * tick, -one, TimeInForce.GTC], { account: seller2.account });
      await networkHelpers.time.increase(86400);

      const pending = await perps.read.getPendingFunding([data.backstop]);
      assert.ok(pending < 0n, "short backstop receives funding");

      // Unwind buys seller2's ask (inside a 1% band); funding is settled first.
      await vault.write.setBackstopParams([100, 0], { account: owner.account });
      const hash = await perps.write.unwindBackstop([one], { account: buyer2.account });
      const receipt = await pc.waitForTransactionReceipt({ hash });
      const settled = parseEventLogs({ logs: receipt.logs, abi: perps.abi, eventName: "FundingSettled" })
        .filter((e) => getAddress(e.args.user) === getAddress(data.backstop));
      assert.equal(settled.length, 1);
      assert.ok(settled[0].args.amount < 0n);
      assert.equal(await perps.read.getPendingFunding([data.backstop]), 0n);
      // Funding received lands as backstop balance (minus the small loss on covering 2 ticks up).
      const loss = data.value(mark + 3n * tick, one) - data.value(mark, one);
      assert.equal(await vault.read.balanceOf([data.backstop]), -settled[0].args.amount - loss);
    });
  });

  describe("unwindBackstop", function () {
    it("buys from a resting ask inside the band and pays the caller from the fee pot", async function () {
      const data = await networkHelpers.loadFixture(backstopFixture);
      const { perps, vault } = data.contracts;
      const { owner, buyer, buyer2, pc } = data.accounts;
      const { qty, minimumPriceIncrement } = data.config;

      await data.handOffAll();
      const bandBps = 100;
      const feeBps = 10;
      await vault.write.setBackstopParams([bandBps, feeBps], { account: owner.account });
      const pot = parseUnits("50", data.config.tokenDecimals);
      await vault.write.depositFor([perps.address, pot], { account: owner.account });

      const mark = await perps.read.getMarketPrice();
      const askQty = parseUnits("5", data.config.quantityDecimals);
      // Buyer (long 40) offers to sell 5 at the mark; the backstop buys to cover.
      await perps.write.createOrder([mark, -askQty, TimeInForce.GTC], { account: buyer.account });

      const callerBefore = await vault.read.balanceOf([buyer2.account.address]);
      const hash = await perps.write.unwindBackstop([askQty], { account: buyer2.account });
      const receipt = await pc.waitForTransactionReceipt({ hash });

      assert.equal((await perps.read.getUserPosition([data.backstop])).netQuantity, -(qty - askQty));
      assert.equal((await perps.read.getUserPosition([buyer.account.address])).netQuantity, qty - askQty);
      assert.equal(await data.netSum(), 0n);

      const expectedFee = (data.value(mark, askQty) * BigInt(feeBps)) / BPS;
      assert.ok(expectedFee > 0n);
      assert.equal((await vault.read.balanceOf([buyer2.account.address])) - callerBefore, expectedFee);
      assert.equal(await perps.read.collectedFeesBalance(), pot - expectedFee);

      const [unwound] = parseEventLogs({ logs: receipt.logs, abi: perps.abi, eventName: "BackstopUnwound" });
      assert.equal(getAddress(unwound.args.caller), getAddress(buyer2.account.address));
      assert.equal(unwound.args.filledQuantity, askQty);
      assert.equal(unwound.args.fee, expectedFee);

      const [created] = parseEventLogs({ logs: receipt.logs, abi: perps.abi, eventName: "OrderCreated" });
      assert.equal(getAddress(created.args.participant), getAddress(data.backstop));
      assert.equal(created.args.quantity, askQty);
      const offset = (mark * BigInt(bandBps)) / BPS;
      assert.equal(created.args.price, ((mark + offset) / minimumPriceIncrement) * minimumPriceIncrement);
      assert.ok(created.args.price >= mark && created.args.price <= mark + offset);
    });

    it("fills partially when the book is thinner than the request", async function () {
      const data = await networkHelpers.loadFixture(backstopFixture);
      const { perps } = data.contracts;
      const { buyer, buyer2, pc } = data.accounts;
      const { qty, one } = data.config;

      await data.handOffAll();
      const mark = await perps.read.getMarketPrice();
      await perps.write.createOrder([mark, -one * 2n, TimeInForce.GTC], { account: buyer.account });

      const hash = await perps.write.unwindBackstop([qty], { account: buyer2.account });
      const receipt = await pc.waitForTransactionReceipt({ hash });
      const [unwound] = parseEventLogs({ logs: receipt.logs, abi: perps.abi, eventName: "BackstopUnwound" });
      assert.equal(unwound.args.filledQuantity, one * 2n);
      assert.equal(unwound.args.fee, 0n);
      assert.equal((await perps.read.getUserPosition([data.backstop])).netQuantity, -(qty - one * 2n));
    });

    it("reverts TimeInForceNotFilled when the only liquidity sits outside the band", async function () {
      const data = await networkHelpers.loadFixture(backstopFixture);
      const { perps, vault } = data.contracts;
      const { owner, buyer, buyer2 } = data.accounts;
      const { one, minimumPriceIncrement } = data.config;

      await data.handOffAll();
      await vault.write.setBackstopParams([100, 0], { account: owner.account });
      const mark = await perps.read.getMarketPrice();
      const farAsk = (((mark * 110n) / 100n) / minimumPriceIncrement) * minimumPriceIncrement;
      await perps.write.createOrder([farAsk, -one * 5n, TimeInForce.GTC], { account: buyer.account });

      await viem.assertions.revertWithCustomError(
        perps.write.unwindBackstop([one], { account: buyer2.account }),
        perps,
        "TimeInForceNotFilled",
      );
    });

    it("caps the caller fee at the fee pot and charges the backstop no taker fee", async function () {
      const data = await networkHelpers.loadFixture(backstopFixture);
      const { perps, vault } = data.contracts;
      const { owner, buyer, buyer2, pc } = data.accounts;
      const { one } = data.config;

      await data.handOffAll();
      await vault.write.setBackstopParams([100, 2_500], { account: owner.account });
      await perps.write.setTakerFeeBps([100], { account: owner.account });
      const pot = 7n;
      await vault.write.depositFor([perps.address, pot], { account: owner.account });
      const mark = await perps.read.getMarketPrice();
      await perps.write.createOrder([mark, -one, TimeInForce.GTC], { account: buyer.account });

      const hash = await perps.write.unwindBackstop([one], { account: buyer2.account });
      const receipt = await pc.waitForTransactionReceipt({ hash });
      const [unwound] = parseEventLogs({ logs: receipt.logs, abi: perps.abi, eventName: "BackstopUnwound" });
      assert.equal(unwound.args.fee, pot);
      assert.equal(await perps.read.collectedFeesBalance(), 0n);
      const [matched] = parseEventLogs({ logs: receipt.logs, abi: perps.abi, eventName: "OrderMatched" });
      assert.equal(matched.args.takerFee, 0n);
      assert.equal(parseEventLogs({ logs: receipt.logs, abi: vault.abi, eventName: "BadDebt" }).length, 0);
      assert.equal(await vault.read.balanceOf([data.backstop]), 0n);
    });

    it("stays open while the vault is halted", async function () {
      const data = await networkHelpers.loadFixture(backstopFixture);
      const { perps, vault } = data.contracts;
      const { owner, buyer, buyer2 } = data.accounts;
      const { qty, one } = data.config;

      await data.handOffAll();
      const mark = await perps.read.getMarketPrice();
      await perps.write.createOrder([mark, -one, TimeInForce.GTC], { account: buyer.account });
      await vault.write.halt({ account: owner.account });

      await perps.write.unwindBackstop([one], { account: buyer2.account });
      assert.equal((await perps.read.getUserPosition([data.backstop])).netQuantity, -(qty - one));
    });

    it("rejects zero quantity and a flat backstop", async function () {
      const data = await networkHelpers.loadFixture(backstopFixture);
      const { perps } = data.contracts;
      const { buyer2 } = data.accounts;

      await viem.assertions.revertWithCustomError(
        perps.write.unwindBackstop([data.config.one], { account: buyer2.account }),
        perps,
        "PositionNotExists",
      );
      await viem.assertions.revertWithCustomError(
        perps.write.unwindBackstop([0n], { account: buyer2.account }),
        perps,
        "InvalidQty",
      );
    });

    it("realizes the backstop's loss against the fund as BadDebt when it covers above its entry", async function () {
      const data = await networkHelpers.loadFixture(backstopFixture);
      const { perps, vault } = data.contracts;
      const { buyer, buyer2, pc } = data.accounts;
      const { one } = data.config;

      const handOffMark = await data.handOffAll(); // short at 1.3·entry
      const mark = await data.pump(14n, 10n); // covers at 1.4·entry: a loss
      await perps.write.createOrder([mark, -one * 2n, TimeInForce.GTC], { account: buyer.account });

      const debtBefore = await vault.read.traderBadDebtTotal();
      const hash = await perps.write.unwindBackstop([one * 2n], { account: buyer2.account });
      const receipt = await pc.waitForTransactionReceipt({ hash });
      const badDebt = parseEventLogs({ logs: receipt.logs, abi: vault.abi, eventName: "BadDebt" });
      assert.equal(badDebt.length, 1);
      assert.equal(getAddress(badDebt[0].args.payer), getAddress(data.backstop));
      const loss = data.value(mark, one * 2n) - data.value(handOffMark, one * 2n);
      assert.equal(badDebt[0].args.amount, loss);
      assert.equal((await vault.read.traderBadDebtTotal()) - debtBefore, loss);
    });
  });

  describe("guards", function () {
    it("liquidation entry points refuse the backstop account", async function () {
      const data = await networkHelpers.loadFixture(backstopFixture);
      const { perps } = data.contracts;
      const { buyer2 } = data.accounts;

      await viem.assertions.revertWithCustomError(
        perps.write.liquidateOrder([data.backstop, zeroHash], { account: buyer2.account }),
        perps,
        "BackstopAccount",
      );
      await viem.assertions.revertWithCustomError(
        perps.write.liquidateOrders([data.backstop, [zeroHash]], { account: buyer2.account }),
        perps,
        "BackstopAccount",
      );
      await viem.assertions.revertWithCustomError(
        perps.write.liquidatePosition([data.backstop, data.config.one], { account: buyer2.account }),
        perps,
        "BackstopAccount",
      );
    });
  });

  describe("forceClosePositions", function () {
    it("only runs while halted and only for the owner", async function () {
      const data = await networkHelpers.loadFixture(backstopFixture);
      const { perps, vault } = data.contracts;
      const { owner, seller } = data.accounts;

      await viem.assertions.revertWithCustomError(
        perps.write.forceClosePositions([[seller.account.address]], { account: owner.account }),
        perps,
        "NotHalted",
      );
      await vault.write.halt({ account: owner.account });
      await viem.assertions.revertWithCustomError(
        perps.write.forceClosePositions([[seller.account.address]], { account: seller.account }),
        perps,
        "OwnableUnauthorizedAccount",
      );
    });

    it("closes every user at the mark with no fee and no hand-off, skipping flat users", async function () {
      const data = await networkHelpers.loadFixture(backstopFixture);
      const { perps, vault } = data.contracts;
      const { owner, seller, buyer, buyer2, pc } = data.accounts;
      const { qty, entry } = data.config;

      const mark = await data.pump(11n, 10n);
      await vault.write.halt({ account: owner.account });
      const fundBefore = await vault.read.insuranceFundBalance();
      const users = [seller.account.address, buyer.account.address, buyer2.account.address];
      const hash = await perps.write.forceClosePositions([users], { account: owner.account });
      const receipt = await pc.waitForTransactionReceipt({ hash });

      for (const who of [...users, data.backstop]) {
        assert.equal((await perps.read.getUserPosition([who])).netQuantity, 0n);
      }
      const liquidated = parseEventLogs({ logs: receipt.logs, abi: perps.abi, eventName: "PositionLiquidated" });
      assert.equal(liquidated.length, 2, "flat buyer2 skipped");
      const bySeller = liquidated.find((e) => getAddress(e.args.user) === getAddress(seller.account.address));
      assert.ok(bySeller);
      assert.equal(bySeller.args.closedQuantity, -qty);
      assert.equal(bySeller.args.liquidatorFee, 0n);
      assert.equal(bySeller.args.pnl, -(data.value(mark, qty) - data.value(entry, qty)));
      assert.equal(parseEventLogs({ logs: receipt.logs, abi: perps.abi, eventName: "BackstopAssigned" }).length, 0);
      assert.equal(await vault.read.insuranceFundBalance(), fundBefore, "PnL nets through the fund");
    });
  });
});
