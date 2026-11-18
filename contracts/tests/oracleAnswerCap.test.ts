import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { TimeInForce } from "../fixtures/timeInForce.ts";
import { deployPerpsWithCollateralFixture } from "./fixtures.ts";

const { viem, networkHelpers } = await network.connect();

describe("HashPowerPerpsDEX oracle answer cap", function () {
  it("reverts the mark when the feed scales above MAX_PRICE, and accepts MAX_PRICE itself", async function () {
    const { contracts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps, priceOracle } = contracts;
    const tick = config.minimumPriceIncrement;
    const MAX_PRICE = await perps.read.MAX_PRICE();

    await priceOracle.write.setPrice([MAX_PRICE, config.oracle.decimals]);
    assert.equal(await perps.read.getMarketPrice(), MAX_PRICE);

    await priceOracle.write.setPrice([MAX_PRICE + tick, config.oracle.decimals]);
    await viem.assertions.revertWithCustomError(perps.read.getMarketPrice(), perps, "InvalidOracle");
  });

  it("setOracle rejects a feed whose answer scales above MAX_PRICE", async function () {
    const { contracts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const MAX_PRICE = await perps.read.MAX_PRICE();
    const feed = await viem.deployContract("PriceOracleMock", [
      MAX_PRICE + config.minimumPriceIncrement,
      config.oracle.decimals,
    ]);

    await viem.assertions.revertWithCustomError(perps.write.setOracle([feed.address]), perps, "InvalidOracle");
  });

  it("keeps cancels working while the feed is above the cap", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps, priceOracle } = contracts;
    const { buyer } = accounts;
    const price = (await perps.read.getMarketPrice()) - config.minimumPriceIncrement;
    await perps.write.createOrder([price, 1n, TimeInForce.GTC], { account: buyer.account });
    const [orderId] = await perps.read.getUserOrders([buyer.account.address]);

    await priceOracle.write.setPrice([(await perps.read.MAX_PRICE()) * 1000n, config.oracle.decimals]);
    await perps.write.cancelOrder([orderId], { account: buyer.account });

    assert.deepEqual(await perps.read.getUserOrders([buyer.account.address]), []);
  });
});
