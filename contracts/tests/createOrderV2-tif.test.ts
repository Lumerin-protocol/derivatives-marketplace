import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits, parseEventLogs } from "viem";
import { deployPerpsWithCollateralFixture } from "./fixtures.ts";

const { viem, networkHelpers } = await network.connect();

/** Mirrors `HashPowerPerpsDEX.TimeInForce`. */
const TimeInForce = { GTC: 0, IOC: 1, FOK: 2 } as const;

describe("HashPowerPerpsDEX - createOrderV2 time-in-force", () => {
  it("IOC fills available size and does not rest the remainder", async () => {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { seller, buyer, pc } = accounts;

    const marketPrice = await perps.read.getMarketPrice();
    const price = marketPrice;
    const q1 = parseUnits("1", config.quantityDecimals);
    const q3 = parseUnits("3", config.quantityDecimals);

    await perps.write.createOrder([price, -q1], { account: seller.account });

    const tx = await perps.write.createOrderV2([price, q3, TimeInForce.IOC], {
      account: buyer.account,
    });
    const receipt = await pc.waitForTransactionReceipt({ hash: tx });

    const matches = parseEventLogs({
      logs: receipt.logs,
      abi: perps.abi,
      eventName: "OrderMatched",
    });
    assert.equal(matches.length, 1);

    assert.equal((await perps.read.getUserOrders([buyer.account.address])).length, 0);
    assert.equal(await perps.read.getQuantityAtPrice([price, true]), 0n);
    assert.equal(await perps.read.getBestAskPrice(), 0n);
  });


  it("IOC with no liquidity reverts TimeInForceNotFilled", async () => {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { buyer } = accounts;

    const price = await perps.read.getMarketPrice();
    const q1 = parseUnits("1", config.quantityDecimals);

    await viem.assertions.revertWithCustomError(
      perps.write.createOrderV2([price, q1, TimeInForce.IOC], { account: buyer.account }),
      perps,
      "TimeInForceNotFilled",
    );
  });
  it("FOK reverts when the book cannot fill the full size", async () => {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { seller, buyer } = accounts;

    const price = await perps.read.getMarketPrice();
    const q1 = parseUnits("1", config.quantityDecimals);
    const q2 = parseUnits("2", config.quantityDecimals);

    await perps.write.createOrder([price, -q1], { account: seller.account });

    await viem.assertions.revertWithCustomError(
      perps.write.createOrderV2([price, q2, TimeInForce.FOK], { account: buyer.account }),
      perps,
      "TimeInForceNotFilled",
    );

    assert.equal(await perps.read.getQuantityAtPrice([price, false]), q1);
  });

  it("FOK fills fully when liquidity is sufficient", async () => {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { seller, buyer, pc } = accounts;

    const price = await perps.read.getMarketPrice();
    const q2 = parseUnits("2", config.quantityDecimals);

    await perps.write.createOrder([price, -q2], { account: seller.account });

    const tx = await perps.write.createOrderV2([price, q2, TimeInForce.FOK], {
      account: buyer.account,
    });
    const receipt = await pc.waitForTransactionReceipt({ hash: tx });

    assert.equal(
      parseEventLogs({ logs: receipt.logs, abi: perps.abi, eventName: "OrderMatched" }).length,
      1,
    );
    assert.equal((await perps.read.getUserOrders([buyer.account.address])).length, 0);
  });

  it("VERSION is 2.6.1", async () => {
    const { contracts } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    assert.equal(await contracts.perps.read.VERSION(), "2.6.1");
  });
});
