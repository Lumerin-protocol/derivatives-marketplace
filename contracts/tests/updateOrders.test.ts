import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { encodeFunctionData, getAddress, parseEventLogs, parseUnits } from "viem";
import { deployPerpsWithCollateralFixture } from "./fixtures.ts";
import { TimeInForce } from "../fixtures/timeInForce.ts";

const { networkHelpers } = await network.connect();

type OrderIntent = {
  price: bigint;
  quantity: bigint;
  timeInForce: number;
};

type ReduceIntent = {
  orderId: `0x${string}`;
  newQuantity: bigint;
};

describe("HashPowerPerpsDEX.updateOrders (cancel + reduce + create batch)", function () {
  it("cancels then places in one call", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { buyer, pc } = accounts;

    const marketPrice = await perps.read.getMarketPrice();
    const step = config.minimumPriceIncrement;
    const qty = parseUnits("1", config.quantityDecimals);

    const resting: OrderIntent[] = [
      { price: marketPrice - step, quantity: qty, timeInForce: TimeInForce.GTC },
      { price: marketPrice - 2n * step, quantity: qty, timeInForce: TimeInForce.GTC },
    ];
    await perps.write.createOrders([resting], { account: buyer.account });
    const before = await perps.read.getUserOrders([buyer.account.address]);
    assert.equal(before.length, 2);

    const next: OrderIntent[] = [
      { price: marketPrice - 3n * step, quantity: qty, timeInForce: TimeInForce.GTC },
      { price: marketPrice - 4n * step, quantity: qty, timeInForce: TimeInForce.GTC },
    ];
    const tx = await perps.write.updateOrders([before, [], next], { account: buyer.account });
    const receipt = await pc.waitForTransactionReceipt({ hash: tx });
    assert.equal(receipt.status, "success");

    const cancelled = parseEventLogs({
      logs: receipt.logs,
      abi: perps.abi,
      eventName: "OrderCancelled",
    });
    const created = parseEventLogs({
      logs: receipt.logs,
      abi: perps.abi,
      eventName: "OrderCreated",
    });
    assert.equal(cancelled.length, 2);
    assert.equal(created.length, 2);

    const after = await perps.read.getUserOrders([buyer.account.address]);
    assert.equal(after.length, 2);
    for (const id of after) {
      assert.ok(!before.includes(id), "old ids must be gone");
      assert.equal(getAddress((await perps.read.getOrder([id])).participant), getAddress(buyer.account.address));
    }
  });

  it("supports cancel-only and create-only batches", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { buyer, pc } = accounts;

    const marketPrice = await perps.read.getMarketPrice();
    const step = config.minimumPriceIncrement;
    const qty = parseUnits("1", config.quantityDecimals);

    await perps.write.updateOrders(
      [[], [], [{ price: marketPrice - step, quantity: qty, timeInForce: TimeInForce.GTC }]],
      { account: buyer.account },
    );
    const placed = await perps.read.getUserOrders([buyer.account.address]);
    assert.equal(placed.length, 1);

    const tx = await perps.write.updateOrders([placed, [], []], { account: buyer.account });
    const receipt = await pc.waitForTransactionReceipt({ hash: tx });
    assert.equal(receipt.status, "success");
    assert.equal((await perps.read.getUserOrders([buyer.account.address])).length, 0);
  });

  it("reduces size in place and keeps FIFO head", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { buyer, pc } = accounts;

    const marketPrice = await perps.read.getMarketPrice();
    const step = config.minimumPriceIncrement;
    const qty = parseUnits("3", config.quantityDecimals);
    const price = marketPrice - step;

    await perps.write.createOrders(
      [
        [
          { price, quantity: qty, timeInForce: TimeInForce.GTC },
          { price, quantity: parseUnits("1", config.quantityDecimals), timeInForce: TimeInForce.GTC },
        ],
      ],
      { account: buyer.account },
    );
    const ids = await perps.read.getUserOrders([buyer.account.address]);
    assert.equal(ids.length, 2);
    const head = ids[0];

    const newQty = parseUnits("1", config.quantityDecimals);
    const reduces: ReduceIntent[] = [{ orderId: head, newQuantity: newQty }];
    const tx = await perps.write.updateOrders([[], reduces, []], { account: buyer.account });
    const receipt = await pc.waitForTransactionReceipt({ hash: tx });
    assert.equal(receipt.status, "success");

    const updated = parseEventLogs({
      logs: receipt.logs,
      abi: perps.abi,
      eventName: "OrderUpdated",
    });
    const matched = parseEventLogs({
      logs: receipt.logs,
      abi: perps.abi,
      eventName: "OrderMatched",
    });
    assert.equal(updated.length, 1);
    assert.equal(matched.length, 0, "reduce must not emit OrderMatched");
    assert.equal(updated[0].args.orderId, head);
    assert.equal(updated[0].args.newQuantity, newQty);

    const afterIds = await perps.read.getUserOrders([buyer.account.address]);
    assert.deepEqual(afterIds, ids, "order ids / FIFO membership unchanged");
    assert.equal((await perps.read.getOrder([head])).quantity, newQty);

    // Single-order helper path
    await perps.write.reduceOrderSize([ids[1], parseUnits("1", config.quantityDecimals) / 2n], {
      account: buyer.account,
    });
    assert.equal(
      (await perps.read.getOrder([ids[1]])).quantity,
      parseUnits("1", config.quantityDecimals) / 2n,
    );
  });

  it("rejects grow, zero, and sign flip on reduce", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { buyer } = accounts;

    const marketPrice = await perps.read.getMarketPrice();
    const step = config.minimumPriceIncrement;
    const qty = parseUnits("2", config.quantityDecimals);
    await perps.write.createOrder([marketPrice - step, qty, TimeInForce.GTC], { account: buyer.account });
    const [id] = await perps.read.getUserOrders([buyer.account.address]);

    await assert.rejects(
      () => perps.write.reduceOrderSize([id, 0n], { account: buyer.account }),
      /InvalidReduceQuantity/,
    );
    await assert.rejects(
      () => perps.write.reduceOrderSize([id, qty + 1n], { account: buyer.account }),
      /InvalidReduceQuantity/,
    );
    await assert.rejects(
      () => perps.write.reduceOrderSize([id, -qty / 2n], { account: buyer.account }),
      /InvalidReduceQuantity/,
    );
  });

  it("is cheaper than multicall(cancelOrder × N + createOrders)", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { buyer, seller, pc } = accounts;

    const marketPrice = await perps.read.getMarketPrice();
    const step = config.minimumPriceIncrement;
    const qty = parseUnits("1", config.quantityDecimals);

    const sellerResting: OrderIntent[] = [
      { price: marketPrice + step, quantity: -qty, timeInForce: TimeInForce.GTC },
      { price: marketPrice + 2n * step, quantity: -qty, timeInForce: TimeInForce.GTC },
      { price: marketPrice + 3n * step, quantity: -qty, timeInForce: TimeInForce.GTC },
    ];
    await perps.write.createOrders([sellerResting], { account: seller.account });
    const sellerIds = await perps.read.getUserOrders([seller.account.address]);

    const buyerResting: OrderIntent[] = [
      { price: marketPrice - step, quantity: qty, timeInForce: TimeInForce.GTC },
      { price: marketPrice - 2n * step, quantity: qty, timeInForce: TimeInForce.GTC },
      { price: marketPrice - 3n * step, quantity: qty, timeInForce: TimeInForce.GTC },
    ];
    await perps.write.createOrders([buyerResting], { account: buyer.account });
    const buyerIds = await perps.read.getUserOrders([buyer.account.address]);

    const baselineCalls: `0x${string}`[] = [];
    for (const id of sellerIds) {
      baselineCalls.push(
        encodeFunctionData({
          abi: perps.abi,
          functionName: "cancelOrder",
          args: [id],
        }),
      );
    }
    const sellerNext: OrderIntent[] = [
      { price: marketPrice + 4n * step, quantity: -qty, timeInForce: TimeInForce.GTC },
      { price: marketPrice + 5n * step, quantity: -qty, timeInForce: TimeInForce.GTC },
      { price: marketPrice + 6n * step, quantity: -qty, timeInForce: TimeInForce.GTC },
    ];
    baselineCalls.push(
      encodeFunctionData({
        abi: perps.abi,
        functionName: "createOrders",
        args: [sellerNext],
      }),
    );
    const baselineTx = await perps.write.multicall([baselineCalls], { account: seller.account });
    const baselineGas = (await pc.waitForTransactionReceipt({ hash: baselineTx })).gasUsed;

    const buyerNext: OrderIntent[] = [
      { price: marketPrice - 4n * step, quantity: qty, timeInForce: TimeInForce.GTC },
      { price: marketPrice - 5n * step, quantity: qty, timeInForce: TimeInForce.GTC },
      { price: marketPrice - 6n * step, quantity: qty, timeInForce: TimeInForce.GTC },
    ];
    const batchTx = await perps.write.updateOrders([buyerIds, [], buyerNext], {
      account: buyer.account,
    });
    const batchGas = (await pc.waitForTransactionReceipt({ hash: batchTx })).gasUsed;

    assert.ok(
      batchGas < baselineGas,
      `updateOrders (${batchGas}) should be cheaper than multicall cancel+createOrders (${baselineGas})`,
    );
  });
});
