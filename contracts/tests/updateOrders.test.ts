import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { encodeFunctionData, getAddress, parseEventLogs, parseUnits } from "viem";
import { deployPerpsWithCollateralFixture } from "./fixtures.ts";

const { networkHelpers } = await network.connect();

type OrderIntent = {
  price: bigint;
  quantity: bigint;
};

describe("HashPowerPerpsDEX.updateOrders (cancel + create batch)", function () {
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
      { price: marketPrice - step, quantity: qty },
      { price: marketPrice - 2n * step, quantity: qty },
    ];
    await perps.write.createOrders([resting], { account: buyer.account });
    const before = await perps.read.getUserOrders([buyer.account.address]);
    assert.equal(before.length, 2);

    const next: OrderIntent[] = [
      { price: marketPrice - 3n * step, quantity: qty },
      { price: marketPrice - 4n * step, quantity: qty },
    ];
    const tx = await perps.write.updateOrders([before, next], { account: buyer.account });
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
      [[], [{ price: marketPrice - step, quantity: qty }]],
      { account: buyer.account },
    );
    const placed = await perps.read.getUserOrders([buyer.account.address]);
    assert.equal(placed.length, 1);

    const tx = await perps.write.updateOrders([placed, []], { account: buyer.account });
    const receipt = await pc.waitForTransactionReceipt({ hash: tx });
    assert.equal(receipt.status, "success");
    assert.equal((await perps.read.getUserOrders([buyer.account.address])).length, 0);
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
      { price: marketPrice + step, quantity: -qty },
      { price: marketPrice + 2n * step, quantity: -qty },
      { price: marketPrice + 3n * step, quantity: -qty },
    ];
    await perps.write.createOrders([sellerResting], { account: seller.account });
    const sellerIds = await perps.read.getUserOrders([seller.account.address]);

    const buyerResting: OrderIntent[] = [
      { price: marketPrice - step, quantity: qty },
      { price: marketPrice - 2n * step, quantity: qty },
      { price: marketPrice - 3n * step, quantity: qty },
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
      { price: marketPrice + 4n * step, quantity: -qty },
      { price: marketPrice + 5n * step, quantity: -qty },
      { price: marketPrice + 6n * step, quantity: -qty },
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
      { price: marketPrice - 4n * step, quantity: qty },
      { price: marketPrice - 5n * step, quantity: qty },
      { price: marketPrice - 6n * step, quantity: qty },
    ];
    const batchTx = await perps.write.updateOrders([buyerIds, buyerNext], {
      account: buyer.account,
    });
    const batchGas = (await pc.waitForTransactionReceipt({ hash: batchTx })).gasUsed;

    assert.ok(
      batchGas < baselineGas,
      `updateOrders (${batchGas}) should be cheaper than multicall cancel+createOrders (${baselineGas})`,
    );
  });
});
