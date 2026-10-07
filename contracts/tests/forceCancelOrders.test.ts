import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress, parseEventLogs, zeroAddress } from "viem";
import { TimeInForce } from "../fixtures/timeInForce.ts";
import {
  deployPerpsWithCollateralFixture,
  deployPerpsWithPositionsFixture,
} from "./fixtures.ts";

const { viem, networkHelpers } = await network.connect();

const EMPTY_AGGREGATE = { buyQty: 0n, sellQty: 0n, buyValue: 0n, sellValue: 0n };

describe("HashPowerPerpsDEX.forceCancelOrders", function () {
  it("only runs while halted and only for the owner", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps, vault } = contracts;
    const { owner, buyer } = accounts;

    await viem.assertions.revertWithCustomError(
      perps.write.forceCancelOrders([[buyer.account.address]], { account: owner.account }),
      perps,
      "NotHalted",
    );
    await vault.write.halt({ account: owner.account });
    await viem.assertions.revertWithCustomError(
      perps.write.forceCancelOrders([[buyer.account.address]], { account: buyer.account }),
      perps,
      "OwnableUnauthorizedAccount",
    );
  });

  it("cancels every order of the listed users, one OrderCancelled each", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithPositionsFixture,
    );
    const { perps, vault } = contracts;
    const { owner, seller, buyer, pc } = accounts;
    const tick = config.minimumPriceIncrement;
    const ask = config.marketPrice + tick;

    await perps.write.createOrder([ask, -config.qty, TimeInForce.GTC], { account: seller.account });
    await perps.write.createOrder([ask + tick, -config.qty, TimeInForce.GTC], {
      account: seller.account,
    });
    await perps.write.createOrder([config.marketPrice - tick, config.qty, TimeInForce.GTC], {
      account: buyer.account,
    });
    const sellerOrderIds = await perps.read.getUserOrders([seller.account.address]);
    const buyerOrderIds = await perps.read.getUserOrders([buyer.account.address]);
    const sellerPosition = await perps.read.getUserPosition([seller.account.address]);

    await vault.write.halt({ account: owner.account });
    const hash = await perps.write.forceCancelOrders(
      [[seller.account.address, seller.account.address]],
      { account: owner.account },
    );
    const receipt = await pc.waitForTransactionReceipt({ hash });
    const cancelled = parseEventLogs({ abi: perps.abi, logs: receipt.logs, eventName: "OrderCancelled" });

    assert.deepEqual(cancelled.map((e) => e.args.orderId).sort(), [...sellerOrderIds].sort());
    for (const e of cancelled) {
      assert.equal(getAddress(e.args.participant), getAddress(seller.account.address));
    }
    assert.deepEqual(await perps.read.getUserOrders([seller.account.address]), []);
    for (const orderId of sellerOrderIds) {
      assert.equal((await perps.read.getOrder([orderId])).participant, zeroAddress);
    }
    assert.deepEqual(await perps.read.getOrderAggregate([seller.account.address]), EMPTY_AGGREGATE);
    const [, asks] = await perps.read.getOrderBookPrices([10n]);
    assert.deepEqual(asks, []);

    assert.deepEqual(await perps.read.getUserOrders([buyer.account.address]), buyerOrderIds);
    assert.deepEqual(
      await perps.read.getUserPosition([seller.account.address]),
      sellerPosition,
      "positions are forceClosePositions' job",
    );
  });

  it("empties the venue with forceClosePositions, emitting an event for every change", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithPositionsFixture,
    );
    const { perps, vault } = contracts;
    const { owner, seller, buyer, pc } = accounts;
    const tick = config.minimumPriceIncrement;
    const users = [seller.account.address, buyer.account.address];

    await perps.write.createOrder([config.marketPrice + tick, -config.qty, TimeInForce.GTC], {
      account: seller.account,
    });
    await perps.write.createOrder([config.marketPrice - tick, config.qty, TimeInForce.GTC], {
      account: buyer.account,
    });
    const orderIds = [
      ...(await perps.read.getUserOrders([seller.account.address])),
      ...(await perps.read.getUserOrders([buyer.account.address])),
    ];

    await vault.write.halt({ account: owner.account });
    const cancelReceipt = await pc.waitForTransactionReceipt({
      hash: await perps.write.forceCancelOrders([users], { account: owner.account }),
    });
    const closeReceipt = await pc.waitForTransactionReceipt({
      hash: await perps.write.forceClosePositions([users], { account: owner.account }),
    });
    await vault.write.resume({ account: owner.account });

    const cancelled = parseEventLogs({
      abi: perps.abi,
      logs: cancelReceipt.logs,
      eventName: "OrderCancelled",
    });
    assert.deepEqual(cancelled.map((e) => e.args.orderId).sort(), [...orderIds].sort());
    const liquidated = parseEventLogs({
      abi: perps.abi,
      logs: closeReceipt.logs,
      eventName: "PositionLiquidated",
    });
    assert.deepEqual(
      liquidated.map((e) => [getAddress(e.args.user), e.args.closedQuantity, e.args.liquidatorFee]),
      [
        [getAddress(seller.account.address), -config.qty, 0n],
        [getAddress(buyer.account.address), config.qty, 0n],
      ],
    );

    for (const user of users) {
      assert.deepEqual(await perps.read.getUserOrders([user]), []);
      assert.deepEqual(await perps.read.getUserPosition([user]), { netQuantity: 0n, netEntryValue: 0n });
      assert.deepEqual(await perps.read.getOrderAggregate([user]), EMPTY_AGGREGATE);
    }
    assert.deepEqual(await perps.read.getOrderBookPrices([10n]), [[], []]);

    await perps.write.createOrder([config.marketPrice, config.qty, TimeInForce.GTC], {
      account: buyer.account,
    });
    assert.equal((await perps.read.getUserOrders([buyer.account.address])).length, 1);
  });
});
