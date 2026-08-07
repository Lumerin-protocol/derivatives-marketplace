import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { encodeFunctionData, parseUnits, zeroAddress } from "viem";
import { TimeInForce } from "../fixtures/timeInForce.ts";
import { deployPerpsWithCollateralFixture } from "./fixtures.ts";

const { viem, networkHelpers } = await network.connect();

type Fixture = Awaited<ReturnType<typeof deployPerpsWithCollateralFixture>>;
type Perps = Fixture["contracts"]["perps"];

async function assertCacheMatchesScan(perps: Perps, user: `0x${string}`, quantityDecimals: number) {
  let buyQty = 0n;
  let sellQty = 0n;
  let buyValue = 0n;
  let sellValue = 0n;
  const scale = 10n ** BigInt(quantityDecimals);
  const ids = await perps.read.getUserOrders([user]);
  for (const id of ids) {
    const order = await perps.read.getOrder([id]);
    if (order.quantity > 0n) {
      buyQty += order.quantity;
      buyValue += (order.price * order.quantity) / scale;
    } else {
      const absQty = -order.quantity;
      sellQty += absQty;
      sellValue += (order.price * absQty) / scale;
    }
  }
  assert.deepEqual(await perps.read.getOrderAggregate([user]), {
    buyQty,
    sellQty,
    buyValue,
    sellValue,
  });
}

describe("HashPowerPerpsDEX order aggregate cache migration", function () {
  it("atomically rebuilds old proxy orders into the new aggregate", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps, vault } = contracts;
    const { owner, buyer } = accounts;
    const price = await perps.read.getMarketPrice();
    const tick = config.minimumPriceIncrement;
    const buyQty = parseUnits("1.25", config.quantityDecimals);
    const sellQty = parseUnits("2.5", config.quantityDecimals);
    const buyPrice = price - tick;
    const sellPrice = price + tick;

    await perps.write.createOrder([buyPrice, buyQty, TimeInForce.GTC], {
      account: buyer.account,
    });
    await perps.write.createOrder([sellPrice, -sellQty, TimeInForce.GTC], {
      account: buyer.account,
    });

    const harnessImpl = await viem.deployContract("HashPowerPerpsDEXMigrationHarness", [
      vault.address,
    ]);
    await perps.write.upgradeToAndCall([harnessImpl.address, "0x"], {
      account: owner.account,
    });
    const harness = await viem.getContractAt(
      "HashPowerPerpsDEXMigrationHarness",
      perps.address,
    );
    await harness.write.clearOrderAggregateCache([buyer.account.address], {
      account: owner.account,
    });
    await harness.write.setLegacyOrderCache(
      [buyer.account.address, 111n, 222n, 333n, 444n],
      { account: owner.account },
    );

    assert.deepEqual(await harness.read.getOrderAggregate([buyer.account.address]), {
      buyQty: 0n,
      sellQty: 0n,
      buyValue: 0n,
      sellValue: 0n,
    });
    const zeroRisk = await harness.read.getRiskView([buyer.account.address]);
    assert.equal(zeroRisk.buyOrderDelta, 0n);
    assert.equal(zeroRisk.sellOrderDelta, 0n);
    assert.deepEqual(await harness.read.getLegacyOrderCache([buyer.account.address]), [
      111n,
      222n,
      333n,
      444n,
    ]);
    await assert.rejects(
      () =>
        harness.write.rebuildOrderAggregateCache([[buyer.account.address]], {
          account: buyer.account,
        }),
      /OwnableUnauthorizedAccount/,
    );

    const fixedImpl = await viem.deployContract("HashPowerPerpsDEX", [vault.address]);
    const revertingData = encodeFunctionData({
      abi: fixedImpl.abi,
      functionName: "setPortfolioMargin",
      args: [zeroAddress],
    });
    await assert.rejects(
      () =>
        harness.write.upgradeToAndCall([fixedImpl.address, revertingData], {
          account: owner.account,
        }),
      /ZeroAddress/,
    );
    // A failed migration rolls the implementation write back too.
    await harness.write.clearOrderAggregateCache([buyer.account.address], {
      account: owner.account,
    });

    const migrationData = encodeFunctionData({
      abi: fixedImpl.abi,
      functionName: "rebuildOrderAggregateCache",
      args: [[buyer.account.address, buyer.account.address, owner.account.address]],
    });
    await harness.write.upgradeToAndCall([fixedImpl.address, migrationData], {
      account: owner.account,
    });

    const upgraded = await viem.getContractAt("HashPowerPerpsDEX", perps.address);
    assert.deepEqual(await upgraded.read.getOrderAggregate([buyer.account.address]), {
      buyQty,
      sellQty,
      buyValue: (buyPrice * buyQty) / 10n ** BigInt(config.quantityDecimals),
      sellValue: (sellPrice * sellQty) / 10n ** BigInt(config.quantityDecimals),
    });
    assert.deepEqual(await upgraded.read.getOrderAggregate([owner.account.address]), {
      buyQty: 0n,
      sellQty: 0n,
      buyValue: 0n,
      sellValue: 0n,
    });
    assert.equal(await upgraded.read.VERSION(), "2.14.0");
  });

  it("keeps mixed aggregates exact across create, reduce, cancel, fill, and self-cross", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { buyer, seller } = accounts;
    const price = await perps.read.getMarketPrice();
    const tick = config.minimumPriceIncrement;
    const qty = parseUnits("1", config.quantityDecimals);

    await perps.write.createOrder([price - tick, 3n * qty, TimeInForce.GTC], {
      account: buyer.account,
    });
    await perps.write.createOrder([price + tick, -4n * qty, TimeInForce.GTC], {
      account: buyer.account,
    });
    await assertCacheMatchesScan(perps, buyer.account.address, config.quantityDecimals);

    const buyerIds = await perps.read.getUserOrders([buyer.account.address]);
    const orders = await Promise.all(buyerIds.map((id) => perps.read.getOrder([id])));
    const buyIndex = orders.findIndex((order) => order.quantity > 0n);
    const sellIndex = orders.findIndex((order) => order.quantity < 0n);
    assert.notEqual(buyIndex, -1);
    assert.notEqual(sellIndex, -1);
    await perps.write.reduceOrderSize([buyerIds[buyIndex], 2n * qty], {
      account: buyer.account,
    });
    await perps.write.cancelOrder([buyerIds[sellIndex]], { account: buyer.account });
    await assertCacheMatchesScan(perps, buyer.account.address, config.quantityDecimals);

    await perps.write.createOrder([price + 2n * tick, -3n * qty, TimeInForce.GTC], {
      account: seller.account,
    });
    await perps.write.createOrder([price + 2n * tick, qty, TimeInForce.GTC], {
      account: buyer.account,
    });
    await assertCacheMatchesScan(perps, seller.account.address, config.quantityDecimals);
    await perps.write.createOrder([price + 2n * tick, 2n * qty, TimeInForce.GTC], {
      account: buyer.account,
    });
    await assertCacheMatchesScan(perps, seller.account.address, config.quantityDecimals);

    await perps.write.createOrder([price + 3n * tick, -3n * qty, TimeInForce.GTC], {
      account: buyer.account,
    });
    await perps.write.createOrder([price + 3n * tick, qty, TimeInForce.GTC], {
      account: buyer.account,
    });
    await assertCacheMatchesScan(perps, buyer.account.address, config.quantityDecimals);
  });

  it("uses canonical remaining-order rounding after partial and full fills", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { buyer, seller } = accounts;
    const price = await perps.read.getMarketPrice();

    await perps.write.createOrder([price, -3n, TimeInForce.GTC], {
      account: seller.account,
    });
    await perps.write.createOrder([price, 1n, TimeInForce.GTC], {
      account: buyer.account,
    });
    await assertCacheMatchesScan(perps, seller.account.address, config.quantityDecimals);

    await perps.write.createOrder([price, 2n, TimeInForce.GTC], {
      account: buyer.account,
    });
    await assertCacheMatchesScan(perps, seller.account.address, config.quantityDecimals);
  });

  it("clears both aggregate sides during reset", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { owner, buyer } = accounts;
    const price = await perps.read.getMarketPrice();
    const qty = parseUnits("1", config.quantityDecimals);

    await perps.write.createOrder(
      [price - config.minimumPriceIncrement, qty, TimeInForce.GTC],
      { account: buyer.account },
    );
    await perps.write.createOrder(
      [price + config.minimumPriceIncrement, -qty, TimeInForce.GTC],
      { account: buyer.account },
    );
    await perps.write.resetState({ account: owner.account });

    assert.deepEqual(await perps.read.getOrderAggregate([buyer.account.address]), {
      buyQty: 0n,
      sellQty: 0n,
      buyValue: 0n,
      sellValue: 0n,
    });
    assert.equal((await perps.read.getUserOrders([buyer.account.address])).length, 0);
  });
});
