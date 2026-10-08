import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { TimeInForce } from "../fixtures/timeInForce.ts";
import { deployPerpsWithCollateralFixture } from "./fixtures.ts";
import {
  getAverageEntryPrice,
} from "./lib/viewHelpers.ts";

const { networkHelpers } = await network.connect();
const SCALE = 1_000_000n;

function signedValue(price: bigint, quantity: bigint) {
  return (price * quantity) / SCALE;
}

function derivedAverage(entryValue: bigint, quantity: bigint) {
  if (quantity === 0n) return 0n;
  const absEntry = entryValue < 0n ? -entryValue : entryValue;
  const absQty = quantity < 0n ? -quantity : quantity;
  return (absEntry * SCALE) / absQty;
}

describe("HashPowerPerpsDEX exact entry-value accounting", function () {
  it("keeps exact values through increase, partial reduce, flip, close, PnL, and risk", async function () {
    const data = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { contracts, accounts, config } = data;
    const { perps, priceOracle } = contracts;
    const { buyer, seller, buyer2 } = accounts;
    const price = await perps.read.getMarketPrice();
    const tick = config.minimumPriceIncrement;
    const initialQty = 1_000_001n;

    await perps.write.createOrder(
      [price, -initialQty, TimeInForce.GTC],
      { account: seller.account },
    );
    await perps.write.createOrder(
      [price, initialQty, TimeInForce.GTC],
      { account: buyer.account },
    );
    let expectedQty = initialQty;
    let expectedEntry = signedValue(price, initialQty);

    const increaseQty = 500_003n;
    const increasePrice = price + tick;
    await perps.write.createOrder(
      [increasePrice, -increaseQty, TimeInForce.GTC],
      { account: seller.account },
    );
    await perps.write.createOrder(
      [increasePrice, increaseQty, TimeInForce.GTC],
      { account: buyer.account },
    );
    expectedQty += increaseQty;
    expectedEntry += signedValue(increasePrice, increaseQty);
    assert.deepEqual(await perps.read.getUserPosition([buyer.account.address]), {
      netQuantity: expectedQty,
      netEntryValue: expectedEntry,
    });

    const mark = price + 10n * tick;
    await priceOracle.write.setPrice([mark, config.oracle.decimals]);
    const expectedPnl = signedValue(mark, expectedQty) - expectedEntry;
    assert.equal(
      await perps.read.getUnrealizedPnl([buyer.account.address]),
      expectedPnl,
    );
    assert.equal(
      (await perps.read.getRiskView([buyer.account.address])).unrealizedPnl,
      expectedPnl,
    );

    const reduceQty = 300_001n;
    const reducePrice = price + 2n * tick;
    await perps.write.createOrder(
      [reducePrice, reduceQty, TimeInForce.GTC],
      { account: buyer2.account },
    );
    await perps.write.createOrder(
      [reducePrice, -reduceQty, TimeInForce.GTC],
      { account: buyer.account },
    );
    const oldQty = expectedQty;
    expectedQty -= reduceQty;
    expectedEntry = (expectedEntry * expectedQty) / oldQty;
    assert.deepEqual(await perps.read.getUserPosition([buyer.account.address]), {
      netQuantity: expectedQty,
      netEntryValue: expectedEntry,
    });

    const flippedShortQty = 200_003n;
    const flipQuantity = expectedQty + flippedShortQty;
    const flipPrice = price + 3n * tick;
    await perps.write.createOrder(
      [flipPrice, flipQuantity, TimeInForce.GTC],
      { account: buyer2.account },
    );
    await perps.write.createOrder(
      [flipPrice, -flipQuantity, TimeInForce.GTC],
      { account: buyer.account },
    );
    expectedQty = -flippedShortQty;
    expectedEntry = signedValue(flipPrice, expectedQty);
    assert.deepEqual(await perps.read.getUserPosition([buyer.account.address]), {
      netQuantity: expectedQty,
      netEntryValue: expectedEntry,
    });
    assert.equal(
      await getAverageEntryPrice(perps, buyer.account.address),
      derivedAverage(expectedEntry, expectedQty),
    );

    const closePrice = price + 4n * tick;
    await perps.write.createOrder(
      [closePrice, -flippedShortQty, TimeInForce.GTC],
      { account: seller.account },
    );
    await perps.write.createOrder(
      [closePrice, flippedShortQty, TimeInForce.GTC],
      { account: buyer.account },
    );
    assert.deepEqual(await perps.read.getUserPosition([buyer.account.address]), {
      netQuantity: 0n,
      netEntryValue: 0n,
    });
    assert.equal(await getAverageEntryPrice(perps, buyer.account.address), 0n);
  });
});
