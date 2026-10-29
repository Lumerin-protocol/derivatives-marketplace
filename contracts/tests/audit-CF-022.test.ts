import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits } from "viem";
import { deployPerpsFixture } from "./fixtures.ts";
import { TimeInForce } from "../fixtures/timeInForce.ts";

const { networkHelpers } = await network.connect();

/**
 * CF-022 (perps twin AH-DMP-004): a match realizes the maker before the taker, each against the
 * insurance fund. A colluding pair closes at an off-market price so the maker's gain exceeds the
 * fund plus cap headroom: the fund borrows, the vault halts, and the taker's equal loss repays
 * the debt a moment later while withdrawals and orders stay frozen.
 */
describe("CF-022 — a zero-sum perps match cannot leave the vault halted", () => {
  it("does not halt when a maker's gain is repaid by the taker in the same match", async () => {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsFixture);
    const { perps, vault, usdcMock } = contracts;
    const { owner, seller: alice, buyer: bob } = accounts;
    const unit = (n: string) => parseUnits(n, config.tokenDecimals);
    const Q = parseUnits("100", config.quantityDecimals);

    await perps.write.setTakerFeeBps([0], { account: owner.account });
    await perps.write.setMakerFeeBps([0], { account: owner.account });

    // Mainnet fund balance and prd cap.
    const fund = await vault.read.insuranceFundBalance();
    await vault.write.withdrawInsuranceFund([owner.account.address, fund - 143_273n], { account: owner.account });
    await vault.write.setInsuranceDebtCap([unit("2000")], { account: owner.account });
    await usdcMock.write.transfer([bob.account.address, unit("2000")], { account: owner.account });
    await vault.write.deposit([unit("1000")], { account: alice.account });
    await vault.write.deposit([unit("3000")], { account: bob.account });

    const mark = await perps.read.getMarketPrice();
    const close = mark + unit("25");

    await perps.write.createOrder([mark, Q, TimeInForce.GTC], { account: alice.account });
    await perps.write.createOrder([mark, -Q, TimeInForce.IOC], { account: bob.account });

    const fundBefore = await vault.read.insuranceFundBalance();
    const gain = ((close - mark) * Q) / 10n ** BigInt(config.quantityDecimals);
    assert.ok(gain > fundBefore + unit("2000"), "the maker's gain must exceed the fund plus cap headroom");

    await perps.write.createOrder([close, -Q, TimeInForce.GTC], { account: alice.account });
    await perps.write.createOrder([close, Q, TimeInForce.IOC], { account: bob.account });

    assert.equal(await vault.read.insuranceDebt(), 0n);
    assert.equal(await vault.read.halted(), false, "a zero-sum match must not halt the vault");
  });
});
