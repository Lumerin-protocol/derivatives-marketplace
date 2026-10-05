import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { formatUnits, getAddress, parseEventLogs, parseUnits, zeroAddress } from "viem";
import type { NetworkConnection } from "hardhat/types/network";
import type { TransactionReceipt } from "viem";
import { deployPerpsFixture } from "./fixtures.ts";
import { TimeInForce } from "../fixtures/timeInForce.ts";

const { viem, networkHelpers } = await network.connect();

/**
 * Voluntary orders have no price band against the mark, so a trader can close into a
 * colluding bid at one tick. Before 6.8.0 the vault booked whatever the trader could not pay
 * as `BadDebt` while the fund paid the colluder's matching gain in full, either at the fill
 * or at the liquidation of the remainder. The taker must now pay its realized loss in full,
 * and a reducing order below IM must not grow the account's MM deficit.
 *
 * Trader long 10 at the mark with 2x IM, colluder short 10 against it, fees off.
 */
async function collusionFixture(_conn: NetworkConnection) {
  const data = await networkHelpers.loadFixture(deployPerpsFixture);
  const { perps, vault, pme } = data.contracts;
  const { owner, buyer: trader, seller: colluder, buyer2: liquidator, pc } = data.accounts;
  const { quantityDecimals, tokenDecimals } = data.config;

  await perps.write.setTakerFeeBps([0], { account: owner.account });
  await perps.write.setMakerFeeBps([0], { account: owner.account });

  const entry = await perps.read.getMarketPrice();
  const qty = parseUnits("10", quantityDecimals);
  const traderDeposit = entry * 2n;
  const colluderDeposit = entry * 2n;
  await vault.write.deposit([traderDeposit], { account: trader.account });
  await vault.write.deposit([colluderDeposit], { account: colluder.account });

  await perps.write.createOrder([entry, -qty, TimeInForce.GTC], { account: colluder.account });
  await perps.write.createOrder([entry, qty, TimeInForce.GTC], { account: trader.account });

  const fund = await vault.read.INSURANCE_FUND_ADDR();
  const backstop = await perps.read.BACKSTOP();
  const names = new Map<string, string>([
    [getAddress(trader.account.address), "trader"],
    [getAddress(colluder.account.address), "colluder"],
    [getAddress(liquidator.account.address), "liquidator"],
    [getAddress(fund), "fund"],
    [getAddress(backstop), "backstop"],
    [getAddress(perps.address), "perps"],
    [zeroAddress, "mint/burn"],
  ]);
  const name = (addr: string) => names.get(getAddress(addr)) ?? addr;
  const usd = (x: bigint) => formatUnits(x, tokenDecimals);
  const lots = (x: bigint) => `${x > 0n ? "+" : ""}${formatUnits(x, quantityDecimals)}`;
  const abs = (x: bigint) => (x < 0n ? -x : x);
  const accounts = [trader.account.address, colluder.account.address, fund];

  return {
    ...data,
    trader,
    colluder,
    fund,
    config: { ...data.config, entry, qty, traderDeposit, colluderDeposit },
    usd,
    value: (price: bigint, absQty: bigint) => (price * absQty) / 10n ** BigInt(quantityDecimals),

    /** Prints each account's vault balance, position, mark PnL, equity and margins, then the fund. */
    async logState(label: string) {
      console.log(`\n  ── ${label} · mark ${usd(await perps.read.getMarketPrice())}`);
      for (const addr of [trader.account.address, colluder.account.address, backstop]) {
        const [balance, risk, [im, mm]] = await Promise.all([
          vault.read.balanceOf([addr]),
          perps.read.getRiskView([addr]),
          pme.read.computePortfolioMargins([addr]),
        ]);
        if (addr === backstop && balance === 0n && risk.netPositionDelta === 0n) continue;
        const equity = balance + risk.unrealizedPnl - risk.pendingFunding;
        console.log(
          `     ${name(addr).padEnd(9)} balance ${usd(balance).padStart(9)}` +
            ` | position ${lots(risk.netPositionDelta).padStart(5)}` +
            ` | uPnL ${usd(risk.unrealizedPnl).padStart(8)}` +
            ` | equity ${usd(equity).padStart(8)}` +
            ` | IM ${usd(im).padStart(6)} | MM ${usd(mm).padStart(6)}` +
            (balance < mm && addr !== backstop ? " | LIQUIDATABLE" : ""),
        );
      }
      const [fundBalance, badDebtTotal, insuranceDebt] = await Promise.all([
        vault.read.balanceOf([fund]),
        vault.read.traderBadDebtTotal(),
        vault.read.insuranceDebt(),
      ]);
      console.log(
        `     fund      balance ${usd(fundBalance)} | traderBadDebtTotal ${usd(badDebtTotal)} | insuranceDebt ${usd(insuranceDebt)}`,
      );
    },

    /** Sends a transaction and prints its fills, vault transfers, liquidations and bad debt in log order. */
    async send(label: string, tx: Promise<`0x${string}`>): Promise<TransactionReceipt> {
      console.log(`\n  ▶ ${label}`);
      const receipt = await pc.waitForTransactionReceipt({ hash: await tx });
      assert.equal(receipt.status, "success");
      for (const log of receipt.logs) {
        const addr = getAddress(log.address);
        if (addr === getAddress(perps.address)) {
          for (const evt of parseEventLogs({ abi: perps.abi, logs: [log] })) {
            if (evt.eventName === "OrderMatched") {
              const { maker, taker, tradePrice, takerQuantity } = evt.args;
              const side = takerQuantity > 0n ? "buys" : "sells";
              console.log(
                `     fill      ${name(taker)} ${side} ${formatUnits(abs(takerQuantity), quantityDecimals)} @ ${usd(tradePrice)} from ${name(maker)}`,
              );
            } else if (evt.eventName === "PositionLiquidated") {
              const { user, closedQuantity, pnl } = evt.args;
              console.log(`     liquidate ${name(user)} closed ${lots(closedQuantity)} at the mark, realized PnL ${usd(pnl)}`);
            } else if (evt.eventName === "BackstopAssigned") {
              const { user, quantity, price } = evt.args;
              console.log(`     backstop  inherits ${lots(quantity)} from ${name(user)} @ ${usd(price)}`);
            }
          }
        } else if (addr === getAddress(vault.address)) {
          for (const evt of parseEventLogs({ abi: vault.abi, logs: [log] })) {
            if (evt.eventName === "Transfer") {
              const { from, to, value } = evt.args;
              console.log(`     transfer  ${name(from)} → ${name(to)} ${usd(value)}`);
            } else if (evt.eventName === "BadDebt") {
              const { payer, receiver, amount } = evt.args;
              console.log(`     BAD DEBT  ${name(payer)} could not pay ${name(receiver)} ${usd(amount)}`);
            }
          }
        }
      }
      return receipt;
    },

    /** Asserts the order reverts with `InsufficientMarginBalance` and leaves every balance and position untouched. */
    async expectRejected(label: string, tx: Promise<`0x${string}`>) {
      console.log(`\n  ▶ ${label}`);
      const before = await Promise.all([
        ...accounts.map((a) => vault.read.balanceOf([a])),
        ...accounts.map((a) => perps.read.getUserPosition([a]).then((p) => p.netQuantity)),
        vault.read.traderBadDebtTotal(),
      ]);
      await viem.assertions.revertWithCustomError(tx, perps, "InsufficientMarginBalance");
      console.log("     reverted  InsufficientMarginBalance");
      const after = await Promise.all([
        ...accounts.map((a) => vault.read.balanceOf([a])),
        ...accounts.map((a) => perps.read.getUserPosition([a]).then((p) => p.netQuantity)),
        vault.read.traderBadDebtTotal(),
      ]);
      assert.deepEqual(after, before);
    },

    badDebts(receipt: TransactionReceipt) {
      return parseEventLogs({ logs: receipt.logs, abi: vault.abi, eventName: "BadDebt" });
    },
  };
}

describe("HashPowerPerpsDEX - voluntary fills cannot create bad debt", function () {
  describe("rejects an off-market close the trader cannot pay", function () {
    it("createOrder: a full close whose loss exceeds the balance", async function () {
      const data = await networkHelpers.loadFixture(collusionFixture);
      const { perps, pme } = data.contracts;
      const { trader, colluder, usd } = data;
      const { entry, qty, traderDeposit, minimumPriceIncrement: tick } = data.config;

      await data.send("colluder bids 10 @ one tick", perps.write.createOrder([tick, qty, TimeInForce.GTC], { account: colluder.account }));
      await data.logState("before the off-market close");
      assert.equal(await pme.read.isLiquidatable([trader.account.address]), false);

      const loss = data.value(entry, qty) - data.value(tick, qty);
      console.log(`\n     trader would lose ${usd(loss)} but holds ${usd(traderDeposit)}`);
      await data.expectRejected(
        "trader sells 10 @ one tick (reduce-only IOC via createOrder)",
        perps.write.createOrder([tick, -qty, TimeInForce.IOC], { account: trader.account }),
      );
    });

    it("createOrders: the same close through the strict batch path", async function () {
      const data = await networkHelpers.loadFixture(collusionFixture);
      const { perps } = data.contracts;
      const { trader, colluder } = data;
      const { qty, minimumPriceIncrement: tick } = data.config;

      await data.send("colluder bids 10 @ one tick", perps.write.createOrder([tick, qty, TimeInForce.GTC], { account: colluder.account }));
      await data.expectRejected(
        "trader sells 10 @ one tick (IOC via createOrders)",
        perps.write.createOrders([[{ price: tick, quantity: -qty, timeInForce: TimeInForce.IOC }]], {
          account: trader.account,
        }),
      );
    });

    it("createOrder: a partial close the trader can pay but that leaves the remainder with negative equity", async function () {
      const data = await networkHelpers.loadFixture(collusionFixture);
      const { perps, priceOracle } = data.contracts;
      const { trader, colluder } = data;
      const { quantityDecimals, minimumPriceIncrement: tick, oracle } = data.config;
      const slice = parseUnits("1.5", quantityDecimals);

      await priceOracle.write.setPrice([parseUnits("38", oracle.decimals), oracle.decimals]);
      await data.send("colluder bids 1.5 @ one tick", perps.write.createOrder([tick, slice, TimeInForce.GTC], { account: colluder.account }));
      await data.logState("mark 38: trader losing but above MM");
      await data.expectRejected(
        "trader sells 1.5 @ one tick (reduce-only IOC via createOrder)",
        perps.write.createOrder([tick, -slice, TimeInForce.IOC], { account: trader.account }),
      );
    });
  });

  describe("still lets losing traders reduce", function () {
    it("a full close at an off-market price the trader can pay", async function () {
      const data = await networkHelpers.loadFixture(collusionFixture);
      const { perps, vault } = data.contracts;
      const { trader, colluder, fund, usd } = data;
      const { entry, qty, traderDeposit, tokenDecimals } = data.config;
      const exit = parseUnits("34", tokenDecimals);
      const loss = data.value(entry, qty) - data.value(exit, qty);
      assert.ok(loss <= traderDeposit);

      await data.send("colluder bids 10 @ 34", perps.write.createOrder([exit, qty, TimeInForce.GTC], { account: colluder.account }));
      const fundBefore = await vault.read.balanceOf([fund]);
      const receipt = await data.send(
        `trader sells 10 @ 34, losing ${usd(loss)} of its ${usd(traderDeposit)}`,
        perps.write.createOrder([exit, -qty, TimeInForce.IOC], { account: trader.account }),
      );
      await data.logState("after the close");

      assert.equal(data.badDebts(receipt).length, 0);
      assert.equal((await perps.read.getUserPosition([trader.account.address])).netQuantity, 0n);
      assert.equal(await vault.read.balanceOf([trader.account.address]), traderDeposit - loss);
      assert.equal(await vault.read.balanceOf([fund]), fundBefore, "the colluder's gain is the trader's own loss");
    });

    it("a below-IM trader reduces near the mark and stays below IM", async function () {
      const data = await networkHelpers.loadFixture(collusionFixture);
      const { perps, vault, pme, priceOracle } = data.contracts;
      const { trader, colluder } = data;
      const { quantityDecimals, oracle } = data.config;
      const traderAddr = trader.account.address;
      const mark = parseUnits("37", oracle.decimals);
      const price = mark - data.config.minimumPriceIncrement;
      const slice = parseUnits("1", quantityDecimals);

      await priceOracle.write.setPrice([mark, oracle.decimals]);
      await data.logState("mark 37: trader below IM, above MM");
      assert.ok((await vault.read.balanceOf([traderAddr])) < (await pme.read.computePortfolioIM([traderAddr])));
      assert.equal(await pme.read.isLiquidatable([traderAddr]), false);

      await data.send("colluder bids 1 one tick under the mark", perps.write.createOrder([price, slice, TimeInForce.GTC], { account: colluder.account }));
      const receipt = await data.send(
        "trader sells 1 one tick under the mark",
        perps.write.createOrder([price, -slice, TimeInForce.IOC], { account: trader.account }),
      );
      await data.logState("after the reduce");

      assert.equal(data.badDebts(receipt).length, 0);
      assert.equal((await perps.read.getUserPosition([traderAddr])).netQuantity, parseUnits("9", quantityDecimals));
      assert.ok((await vault.read.balanceOf([traderAddr])) < (await pme.read.computePortfolioIM([traderAddr])));
    });

    it("a liquidatable trader reduces near the mark without growing its MM deficit", async function () {
      const data = await networkHelpers.loadFixture(collusionFixture);
      const { perps, vault, pme, priceOracle } = data.contracts;
      const { trader, colluder } = data;
      const { quantityDecimals, oracle } = data.config;
      const traderAddr = trader.account.address;
      const mark = parseUnits("35", oracle.decimals);
      const price = mark - data.config.minimumPriceIncrement;
      const slice = parseUnits("2", quantityDecimals);
      const deficit = async () =>
        (await pme.read.computePortfolioMM([traderAddr])) - (await vault.read.balanceOf([traderAddr]));

      await priceOracle.write.setPrice([mark, oracle.decimals]);
      await data.logState("mark 35: trader below MM");
      assert.equal(await pme.read.isLiquidatable([traderAddr]), true);
      const deficitBefore = await deficit();

      await data.send("colluder bids 2 one tick under the mark", perps.write.createOrder([price, slice, TimeInForce.GTC], { account: colluder.account }));
      const receipt = await data.send(
        "trader sells 2 one tick under the mark",
        perps.write.createOrder([price, -slice, TimeInForce.IOC], { account: trader.account }),
      );
      await data.logState("after the reduce");

      assert.equal(data.badDebts(receipt).length, 0);
      assert.equal((await perps.read.getUserPosition([traderAddr])).netQuantity, parseUnits("8", quantityDecimals));
      assert.ok((await deficit()) < deficitBefore);
    });
  });
});
