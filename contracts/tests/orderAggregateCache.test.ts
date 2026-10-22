import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseUnits } from "viem";
import { TimeInForce } from "../fixtures/timeInForce.ts";
import { deployPerpsWithCollateralFixture } from "./fixtures.ts";

const { networkHelpers } = await network.connect();

type Fixture = Awaited<ReturnType<typeof deployPerpsWithCollateralFixture>>;
type Perps = Fixture["contracts"]["perps"];

const EMPTY_AGGREGATE = { buyQty: 0n, sellQty: 0n, buyPQ: 0n, buyP2Q: 0n, sellPQ: 0n, sellP2Q: 0n };

/** Expected cache for one side's orders: quantity and unscaled Σp·q, Σp²·q per side. */
function aggregateOf(orders: { price: bigint; quantity: bigint }[]) {
  const aggregate = { ...EMPTY_AGGREGATE };
  for (const { price, quantity } of orders) {
    if (quantity > 0n) {
      aggregate.buyQty += quantity;
      aggregate.buyPQ += price * quantity;
      aggregate.buyP2Q += price * price * quantity;
    } else if (quantity < 0n) {
      aggregate.sellQty -= quantity;
      aggregate.sellPQ -= price * quantity;
      aggregate.sellP2Q -= price * price * quantity;
    }
  }
  return aggregate;
}

async function assertCacheMatchesScan(perps: Perps, user: `0x${string}`) {
  const ids = await perps.read.getUserOrders([user]);
  const orders = await Promise.all(ids.map((id) => perps.read.getOrder([id])));
  assert.deepEqual(await perps.read.getOrderAggregate([user]), aggregateOf(orders));
}

describe("HashPowerPerpsDEX order aggregate cache migration", function () {
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
    await assertCacheMatchesScan(perps, buyer.account.address);

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
    await assertCacheMatchesScan(perps, buyer.account.address);

    await perps.write.createOrder([price + 2n * tick, -3n * qty, TimeInForce.GTC], {
      account: seller.account,
    });
    await perps.write.createOrder([price + 2n * tick, qty, TimeInForce.GTC], {
      account: buyer.account,
    });
    await assertCacheMatchesScan(perps, seller.account.address);
    await perps.write.createOrder([price + 2n * tick, 2n * qty, TimeInForce.GTC], {
      account: buyer.account,
    });
    await assertCacheMatchesScan(perps, seller.account.address);

    await perps.write.createOrder([price + 3n * tick, -3n * qty, TimeInForce.GTC], {
      account: buyer.account,
    });
    await perps.write.createOrder([price + 3n * tick, qty, TimeInForce.GTC], {
      account: buyer.account,
    });
    await assertCacheMatchesScan(perps, buyer.account.address);
  });

  it("uses canonical remaining-order rounding after partial and full fills", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(
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
    await assertCacheMatchesScan(perps, seller.account.address);

    await perps.write.createOrder([price, 2n, TimeInForce.GTC], {
      account: buyer.account,
    });
    await assertCacheMatchesScan(perps, seller.account.address);
  });

  it("clears both aggregate sides during resetState", async function () {
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
    await perps.write.resetState([[buyer.account.address]], {
      account: owner.account,
    });

    assert.deepEqual(await perps.read.getOrderAggregate([buyer.account.address]), EMPTY_AGGREGATE);
    assert.equal((await perps.read.getUserOrders([buyer.account.address])).length, 0);
  });
});
