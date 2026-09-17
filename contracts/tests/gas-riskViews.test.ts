import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { encodeFunctionData, parseUnits } from "viem";
import { TimeInForce } from "../fixtures/timeInForce.ts";
import {
  deployPerpsWithCollateralFixture,
  deployPerpsWithFundingAndPositionsFixture,
} from "./fixtures.ts";

const { networkHelpers } = await network.getOrCreate();

describe("Gas: risk views", () => {
  it("getRiskView inactive user", async () => {
    const { contracts, accounts } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { buyer, pc } = accounts;
    const gas = await pc.estimateGas({
      account: buyer.account,
      to: perps.address,
      data: encodeFunctionData({
        abi: perps.abi,
        functionName: "getRiskView",
        args: [buyer.account.address],
      }),
    });
    const risk = await perps.read.getRiskView([buyer.account.address]);

    assert.deepEqual(
      [
        risk.netPositionDelta,
        risk.unrealizedPnl,
        risk.pendingFunding,
        risk.buyOrderDelta,
        risk.sellOrderDelta,
        risk.buyOrderFillLoss,
        risk.sellOrderFillLoss,
      ],
      [0n, 0n, 0n, 0n, 0n, 0n, 0n],
    );
    console.log(`  getRiskView inactive user: ${gas.toLocaleString()} gas`);
  });

  it("getRiskView position and resting order", async () => {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { seller, buyer, pc } = accounts;
    const marketPrice = await perps.read.getMarketPrice();
    const qty = parseUnits("1", config.quantityDecimals);
    await perps.write.createOrder([marketPrice, -qty, TimeInForce.GTC], {
      account: seller.account,
    });
    await perps.write.createOrder([marketPrice, qty, TimeInForce.GTC], {
      account: buyer.account,
    });
    await perps.write.createOrder(
      [marketPrice - config.minimumPriceIncrement, qty, TimeInForce.GTC],
      { account: buyer.account },
    );

    const gas = await pc.estimateGas({
      account: buyer.account,
      to: perps.address,
      data: encodeFunctionData({
        abi: perps.abi,
        functionName: "getRiskView",
        args: [buyer.account.address],
      }),
    });
    const risk = await perps.read.getRiskView([buyer.account.address]);

    assert.ok(risk.netPositionDelta > 0n);
    assert.ok(risk.buyOrderDelta > 0n);
    console.log(`  getRiskView position and resting order: ${gas.toLocaleString()} gas`);
  });

  it("getRiskView position with live funding", async () => {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithFundingAndPositionsFixture,
    );
    const { perps } = contracts;
    const { seller, buyer, buyer2, pc } = accounts;
    const tick = config.minimumPriceIncrement;
    const smallQty = parseUnits("1", config.quantityDecimals);
    await perps.write.createOrder(
      [config.marketPrice + tick, smallQty, TimeInForce.GTC],
      { account: buyer2.account },
    );
    await perps.write.createOrder(
      [config.marketPrice + 3n * tick, -smallQty, TimeInForce.GTC],
      { account: seller.account },
    );
    await networkHelpers.time.increase(86400);

    const gas = await pc.estimateGas({
      account: buyer.account,
      to: perps.address,
      data: encodeFunctionData({
        abi: perps.abi,
        functionName: "getRiskView",
        args: [buyer.account.address],
      }),
    });
    const risk = await perps.read.getRiskView([buyer.account.address]);

    assert.ok(risk.netPositionDelta > 0n);
    assert.ok(risk.pendingFunding > 0n);
    console.log(`  getRiskView position with live funding: ${gas.toLocaleString()} gas`);
  });
});
