import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseEventLogs, parseUnits } from "viem";
import { deployPerpsFixture } from "./fixtures.ts";
import { TimeInForce } from "../fixtures/timeInForce.ts";

const { networkHelpers } = await network.connect();

describe("HashPowerPerpsDEX - realized PnL liveness", function () {
  it("pays the winner in full from an empty fund and records the loser's shortfall", async function () {
    const data = await networkHelpers.loadFixture(deployPerpsFixture);
    const { contracts, accounts, config } = data;
    const { perps, priceOracle, vault } = contracts;
    const { owner, seller, buyer, pc } = accounts;
    const entry = await perps.read.getMarketPrice();
    const quantity = parseUnits("10", config.quantityDecimals);
    const collateral = entry * 2n;

    await perps.write.setTakerFeeBps([0], { account: owner.account });
    await vault.write.deposit([collateral], { account: seller.account });
    await vault.write.deposit([collateral], { account: buyer.account });
    await perps.write.createOrder([entry, -quantity, TimeInForce.GTC], {
      account: seller.account,
    });
    await perps.write.createOrder([entry, quantity, TimeInForce.GTC], {
      account: buyer.account,
    });

    const insuranceBefore = await vault.read.insuranceFundBalance();
    await vault.write.withdrawInsuranceFund([owner.account.address, insuranceBefore], {
      account: owner.account,
    });
    assert.equal(await vault.read.insuranceFundBalance(), 0n);
    await vault.write.setInsuranceDebtCap([parseUnits("1000000", config.tokenDecimals)], {
      account: owner.account,
    });

    const exit = entry * 3n;
    const pnl = ((exit - entry) * quantity) / 10n ** BigInt(config.quantityDecimals);
    const sellerAvailable = await vault.read.balanceOf([seller.account.address]);
    const buyerBefore = await vault.read.balanceOf([buyer.account.address]);
    await priceOracle.write.setPrice([exit, config.oracle.decimals]);

    // Reduce the losing short first so its available collateral reaches insurance;
    // the profitable long then receives that amount and reports the remainder.
    await perps.write.createOrder([exit, quantity, TimeInForce.GTC], {
      account: seller.account,
    });
    const hash = await perps.write.createOrder([exit, -quantity, TimeInForce.GTC], {
      account: buyer.account,
    });
    const receipt = await pc.waitForTransactionReceipt({ hash });

    const debts = parseEventLogs({ logs: receipt.logs, abi: vault.abi, eventName: "BadDebt" });
    const sellerDebt = debts.filter(
      (evt) => evt.args.payer.toLowerCase() === seller.account.address.toLowerCase(),
    );
    assert.equal(sellerDebt.length, 1);
    assert.equal(sellerDebt[0].args.amount, pnl - sellerAvailable);
    assert.equal(await vault.read.balanceOf([seller.account.address]), 0n);
    assert.equal(await vault.read.balanceOf([buyer.account.address]), buyerBefore + pnl);
    assert.equal(await vault.read.insuranceDebt(), pnl - sellerAvailable);
    assert.equal(await vault.read.insuranceFundBalance(), 0n);
    assert.equal((await perps.read.getUserPosition([seller.account.address])).netQuantity, 0n);
    assert.equal((await perps.read.getUserPosition([buyer.account.address])).netQuantity, 0n);
  });
});
