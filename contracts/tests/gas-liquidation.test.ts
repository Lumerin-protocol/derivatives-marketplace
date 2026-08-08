import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseUnits, type Hash } from "viem";
import { TimeInForce } from "../fixtures/timeInForce.ts";
import { deployPerpsFixture } from "./fixtures.ts";

const { networkHelpers } = await network.getOrCreate();

async function deployUnderwaterOrdersFixture(connection: Parameters<typeof deployPerpsFixture>[0]) {
  const data = await deployPerpsFixture(connection);
  const { contracts, accounts, config, utils } = data;
  const { perps, priceOracle, vault } = contracts;
  const { owner, seller, buyer } = accounts;
  const initialPrice = await perps.read.getMarketPrice();
  const tick = config.minimumPriceIncrement;
  const qty = parseUnits("1", config.quantityDecimals);
  const minCollateral = utils.getMinimumCollateral(initialPrice, qty);

  await perps.write.setLiquidationFeeBps([100], { account: owner.account });
  await vault.write.deposit([minCollateral], { account: seller.account });
  await vault.write.deposit([minCollateral * 2n], { account: buyer.account });
  await perps.write.createOrder([initialPrice, -qty, TimeInForce.GTC], { account: seller.account });
  await perps.write.createOrder([initialPrice, qty, TimeInForce.GTC], { account: buyer.account });

  const restingQty = parseUnits("0.1", config.quantityDecimals);
  await perps.write.createOrder([initialPrice + 5n * tick, -restingQty, TimeInForce.GTC], {
    account: seller.account,
  });
  await perps.write.createOrder([initialPrice + 10n * tick, -restingQty, TimeInForce.GTC], {
    account: seller.account,
  });
  await priceOracle.write.setPrice([initialPrice * 2n, config.oracle.decimals]);

  return data;
}

describe("Gas: liquidation", () => {
  it("liquidateOrders_threeStaleThenTwoValid", async () => {
    const { contracts, accounts } = await networkHelpers.loadFixture(deployUnderwaterOrdersFixture);
    const { perps } = contracts;
    const { seller, buyer2, pc } = accounts;
    const orderIds = await perps.read.getUserOrders([seller.account.address]);
    const staleIds = [1n, 2n, 3n].map((id) => `0x${id.toString(16).padStart(64, "0")}` as Hash);

    const hash = await perps.write.liquidateOrders(
      [seller.account.address, [...staleIds, ...orderIds]],
      { account: buyer2.account },
    );
    const receipt = await pc.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    assert.equal((await perps.read.getUserOrders([seller.account.address])).length, 0);
    console.log(
      `  liquidateOrders_threeStaleThenTwoValid: ${Number(receipt.gasUsed).toLocaleString()} gas`,
    );
  });
});
