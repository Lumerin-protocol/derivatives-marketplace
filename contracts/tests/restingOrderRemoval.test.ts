import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress, parseUnits, zeroAddress } from "viem";
import { TimeInForce } from "../fixtures/timeInForce.ts";
import {
  deployPerpsFixture,
  deployPerpsWithCollateralFixture,
} from "./fixtures.ts";

const { networkHelpers } = await network.connect();

type Fixture = Awaited<ReturnType<typeof deployPerpsWithCollateralFixture>>;
type Perps = Fixture["contracts"]["perps"];
type ExpectedOrder = {
  id: `0x${string}`;
  participant: `0x${string}`;
  price: bigint;
  quantity: bigint;
};

async function assertUserOrderState(
  perps: Perps,
  user: `0x${string}`,
  expected: ExpectedOrder[],
  removedIds: `0x${string}`[],
) {
  const actualIds = await perps.read.getUserOrders([user]);
  assert.deepEqual([...actualIds].sort(), expected.map(({ id }) => id).sort());

  let buyQty = 0n;
  let sellQty = 0n;
  let buyValue = 0n;
  let sellValue = 0n;
  for (const expectedOrder of expected) {
    const actual = await perps.read.getOrder([expectedOrder.id]);
    assert.equal(getAddress(actual.participant), getAddress(expectedOrder.participant));
    assert.equal(actual.price, expectedOrder.price);
    assert.equal(actual.quantity, expectedOrder.quantity);
    if (actual.quantity > 0n) {
      buyQty += actual.quantity;
      buyValue += (actual.price * actual.quantity) / 1_000_000n;
    } else {
      sellQty -= actual.quantity;
      sellValue += (actual.price * -actual.quantity) / 1_000_000n;
    }
  }

  assert.deepEqual(await perps.read.getOrderAggregate([user]), {
    buyQty,
    sellQty,
    buyValue,
    sellValue,
  });

  for (const id of removedIds) {
    assert.deepEqual(await perps.read.getOrder([id]), {
      participant: zeroAddress,
      price: 0n,
      quantity: 0n,
    });
  }
}

async function assertPriceLevel(
  perps: Perps,
  price: bigint,
  isBid: boolean,
  expectedQuantity: bigint,
) {
  assert.equal(await perps.read.getQuantityAtPrice([price, isBid]), expectedQuantity);
  const [bids, asks] = await perps.read.getOrderBookPrices([200n]);
  assert.equal((isBid ? bids : asks).includes(price), expectedQuantity !== 0n);
}

describe("HashPowerPerpsDEX resting-order removal invariants", function () {
  it("keeps queue, level, user index, aggregate, and storage exact on cancel", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { buyer } = accounts;
    const price = (await perps.read.getMarketPrice()) - config.minimumPriceIncrement;
    const quantity = parseUnits("2", config.quantityDecimals);

    await perps.write.createOrder([price, quantity, TimeInForce.GTC], {
      account: buyer.account,
    });
    const [orderId] = await perps.read.getUserOrders([buyer.account.address]);
    await perps.write.cancelOrder([orderId], { account: buyer.account });

    await assertUserOrderState(perps, buyer.account.address, [], [orderId]);
    await assertPriceLevel(perps, price, true, 0n);
  });

  it("preserves queue membership while explicit and fill reductions shrink state", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { seller, buyer } = accounts;
    const price = await perps.read.getMarketPrice();
    const quantity = parseUnits("3", config.quantityDecimals);
    const reduced = parseUnits("2", config.quantityDecimals);

    await perps.write.createOrder([price, -quantity, TimeInForce.GTC], {
      account: seller.account,
    });
    const [orderId] = await perps.read.getUserOrders([seller.account.address]);
    await perps.write.reduceOrderSize([orderId, -reduced], { account: seller.account });

    await assertUserOrderState(
      perps,
      seller.account.address,
      [{ id: orderId, participant: seller.account.address, price, quantity: -reduced }],
      [],
    );
    await assertPriceLevel(perps, price, false, reduced);

    const partialFill = parseUnits("1", config.quantityDecimals);
    await perps.write.createOrder([price, partialFill, TimeInForce.GTC], {
      account: buyer.account,
    });
    const remaining = reduced - partialFill;

    await assertUserOrderState(
      perps,
      seller.account.address,
      [{ id: orderId, participant: seller.account.address, price, quantity: -remaining }],
      [],
    );
    await assertPriceLevel(perps, price, false, remaining);
  });

  it("removes a fully filled maker from every resting-order structure", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { seller, buyer } = accounts;
    const price = await perps.read.getMarketPrice();
    const quantity = parseUnits("1", config.quantityDecimals);

    await perps.write.createOrder([price, -quantity, TimeInForce.GTC], {
      account: seller.account,
    });
    await perps.write.createOrder([price, -quantity, TimeInForce.GTC], {
      account: seller.account,
    });
    const [orderId, nextOrderId] = await perps.read.getUserOrders([seller.account.address]);
    await perps.write.createOrder([price, quantity, TimeInForce.GTC], {
      account: buyer.account,
    });

    await assertUserOrderState(
      perps,
      seller.account.address,
      [
        {
          id: nextOrderId,
          participant: seller.account.address,
          price,
          quantity: -quantity,
        },
      ],
      [orderId],
    );
    await assertPriceLevel(perps, price, false, quantity);
  });

  it("uses the same invariants for partial and full self-cross removal", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { seller: user, buyer: other } = accounts;
    const price = await perps.read.getMarketPrice();
    const quantity = parseUnits("2", config.quantityDecimals);
    const half = quantity / 2n;

    await perps.write.createOrder([price, -quantity, TimeInForce.GTC], {
      account: user.account,
    });
    const [partialId] = await perps.read.getUserOrders([user.account.address]);
    await perps.write.createOrder([price, half, TimeInForce.GTC], { account: user.account });

    await assertUserOrderState(
      perps,
      user.account.address,
      [{ id: partialId, participant: user.account.address, price, quantity: -half }],
      [],
    );
    await assertPriceLevel(perps, price, false, half);

    await perps.write.createOrder([price, -half, TimeInForce.GTC], {
      account: other.account,
    });
    const [otherId] = await perps.read.getUserOrders([other.account.address]);
    await perps.write.createOrder([price, half, TimeInForce.GTC], { account: user.account });

    await assertUserOrderState(perps, user.account.address, [], [partialId]);
    await assertUserOrderState(
      perps,
      other.account.address,
      [{ id: otherId, participant: other.account.address, price, quantity: -half }],
      [],
    );
    await assertPriceLevel(perps, price, false, half);
  });

  it("removes liquidated orders from every resting-order structure", async function () {
    const data = await networkHelpers.loadFixture(deployPerpsFixture);
    const { contracts, accounts, config, utils } = data;
    const { perps, priceOracle, vault } = contracts;
    const { seller, buyer, buyer2 } = accounts;
    const price = await perps.read.getMarketPrice();
    const positionQty = parseUnits("1", config.quantityDecimals);
    const restingQty = parseUnits("0.1", config.quantityDecimals);
    const collateral = utils.getMinimumCollateral(price, positionQty);

    await vault.write.deposit([collateral], { account: seller.account });
    await vault.write.deposit([collateral * 2n], { account: buyer.account });
    await perps.write.createOrder([price, -positionQty, TimeInForce.GTC], {
      account: seller.account,
    });
    await perps.write.createOrder([price, positionQty, TimeInForce.GTC], {
      account: buyer.account,
    });

    const restingPrice = price + 5n * config.minimumPriceIncrement;
    await perps.write.createOrder([restingPrice, -restingQty, TimeInForce.GTC], {
      account: seller.account,
    });
    const [orderId] = await perps.read.getUserOrders([seller.account.address]);
    await priceOracle.write.setPrice([price * 2n, config.oracle.decimals]);
    await perps.write.liquidateOrder([seller.account.address, orderId], {
      account: buyer2.account,
    });

    await assertUserOrderState(perps, seller.account.address, [], [orderId]);
    await assertPriceLevel(perps, restingPrice, false, 0n);
  });

  it("routes reset cleanup through the same full-removal invariants", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { owner, buyer } = accounts;
    const price = await perps.read.getMarketPrice();
    const quantity = parseUnits("1", config.quantityDecimals);
    const bidPrice = price - config.minimumPriceIncrement;
    const askPrice = price + config.minimumPriceIncrement;

    await perps.write.createOrder([bidPrice, quantity, TimeInForce.GTC], {
      account: buyer.account,
    });
    await perps.write.createOrder([askPrice, -quantity, TimeInForce.GTC], {
      account: buyer.account,
    });
    const orderIds = await perps.read.getUserOrders([buyer.account.address]);
    await perps.write.resetState({ account: owner.account });

    await assertUserOrderState(perps, buyer.account.address, [], [...orderIds]);
    await assertPriceLevel(perps, bidPrice, true, 0n);
    await assertPriceLevel(perps, askPrice, false, 0n);
  });
});
