import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseUnits } from "viem";
import { TimeInForce } from "../fixtures/timeInForce.ts";
import { deployPerpsWithCollateralFixture } from "./fixtures.ts";

const { networkHelpers } = await network.getOrCreate();

describe("Gas: updateOrders", () => {
  it("cancel-only", async () => {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { buyer, pc } = accounts;
    const marketPrice = await perps.read.getMarketPrice();
    const qty = parseUnits("1", config.quantityDecimals);
    await perps.write.createOrder(
      [marketPrice - config.minimumPriceIncrement, qty, TimeInForce.GTC],
      { account: buyer.account },
    );
    const [orderId] = await perps.read.getUserOrders([buyer.account.address]);

    const hash = await perps.write.updateOrders([[orderId], [], []], { account: buyer.account });
    const receipt = await pc.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    console.log(`  updateOrders_cancelOnly: ${Number(receipt.gasUsed).toLocaleString()} gas`);
  });

  it("reduce-only", async () => {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { buyer, pc } = accounts;
    const marketPrice = await perps.read.getMarketPrice();
    const qty = parseUnits("4", config.quantityDecimals);
    await perps.write.createOrder(
      [marketPrice - config.minimumPriceIncrement, qty, TimeInForce.GTC],
      { account: buyer.account },
    );
    const [orderId] = await perps.read.getUserOrders([buyer.account.address]);

    const hash = await perps.write.updateOrders(
      [[], [{ orderId, newQuantity: qty / 4n }], []],
      { account: buyer.account },
    );
    const receipt = await pc.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    console.log(`  updateOrders_reduceOnly: ${Number(receipt.gasUsed).toLocaleString()} gas`);
  });
});
