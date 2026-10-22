import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress, parseEventLogs, zeroAddress } from "viem";
import { TimeInForce } from "../fixtures/timeInForce.ts";
import { deployPerpsWithPositionsFixture } from "./fixtures.ts";

const { viem, networkHelpers } = await network.connect();

const EMPTY_AGGREGATE = { buyQty: 0n, sellQty: 0n, buyPQ: 0n, buyP2Q: 0n, sellPQ: 0n, sellP2Q: 0n };

describe("HashPowerPerpsDEX.forceCancelOrders", function () {
  it("cancels every resting order of the listed users and nothing else", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithPositionsFixture,
    );
    const { perps } = contracts;
    const { owner, buyer, seller, pc } = accounts;
    const tick = config.minimumPriceIncrement;
    const mark = config.marketPrice;

    for (const [price, quantity] of [
      [mark - tick, 2n],
      [mark - 2n * tick, 3n],
      [mark + tick, -4n],
    ] as const) {
      await perps.write.createOrder([price, quantity, TimeInForce.GTC], { account: buyer.account });
    }
    await perps.write.createOrder([mark + 2n * tick, -5n, TimeInForce.GTC], {
      account: seller.account,
    });
    const buyerOrderIds = await perps.read.getUserOrders([buyer.account.address]);
    const sellerOrderIds = await perps.read.getUserOrders([seller.account.address]);
    const buyerPosition = await perps.read.getUserPosition([buyer.account.address]);
    const sellerPosition = await perps.read.getUserPosition([seller.account.address]);
    const sellerAggregate = await perps.read.getOrderAggregate([seller.account.address]);
    assert.equal(buyerOrderIds.length, 3);

    const hash = await perps.write.forceCancelOrders(
      [[buyer.account.address, buyer.account.address]],
      { account: owner.account },
    );
    const receipt = await pc.waitForTransactionReceipt({ hash });
    const cancelled = parseEventLogs({ abi: perps.abi, logs: receipt.logs, eventName: "OrderCancelled" });
    assert.deepEqual(
      cancelled.map((event) => event.args.orderId).sort(),
      [...buyerOrderIds].sort(),
    );
    for (const event of cancelled) {
      assert.equal(getAddress(event.args.participant), getAddress(buyer.account.address));
    }

    assert.deepEqual(await perps.read.getUserOrders([buyer.account.address]), []);
    for (const orderId of buyerOrderIds) {
      const order = await perps.read.getOrder([orderId]);
      assert.equal(order.participant, zeroAddress);
      assert.equal(order.quantity, 0n);
    }
    assert.deepEqual(await perps.read.getOrderAggregate([buyer.account.address]), EMPTY_AGGREGATE);
    const [bids, asks] = await perps.read.getOrderBookPrices([200n]);
    assert.deepEqual([...bids], []);
    assert.deepEqual([...asks], [mark + 2n * tick]);

    assert.deepEqual(await perps.read.getUserPosition([buyer.account.address]), buyerPosition);
    assert.deepEqual(await perps.read.getUserPosition([seller.account.address]), sellerPosition);
    assert.deepEqual(await perps.read.getUserOrders([seller.account.address]), sellerOrderIds);
    assert.deepEqual(await perps.read.getOrderAggregate([seller.account.address]), sellerAggregate);
  });

  it("is owner-only, works while halted, and keeps order ids monotonic", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithPositionsFixture,
    );
    const { perps, vault } = contracts;
    const { owner, buyer } = accounts;
    const price = config.marketPrice - config.minimumPriceIncrement;

    await perps.write.createOrder([price, 1n, TimeInForce.GTC], { account: buyer.account });
    const [oldOrderId] = await perps.read.getUserOrders([buyer.account.address]);

    await viem.assertions.revertWithCustomError(
      perps.write.forceCancelOrders([[buyer.account.address]], { account: buyer.account }),
      perps,
      "OwnableUnauthorizedAccount",
    );

    await vault.write.halt({ account: owner.account });
    await perps.write.forceCancelOrders([[buyer.account.address]], { account: owner.account });
    assert.deepEqual(await perps.read.getUserOrders([buyer.account.address]), []);
    await vault.write.resume({ account: owner.account });

    await perps.write.createOrder([price, 1n, TimeInForce.GTC], { account: buyer.account });
    const [newOrderId] = await perps.read.getUserOrders([buyer.account.address]);
    assert.ok(BigInt(newOrderId) > BigInt(oldOrderId));
  });
});
