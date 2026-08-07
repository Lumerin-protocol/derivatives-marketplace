import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, parseEventLogs, parseUnits } from "viem";
import { deployPerpsWithCollateralFixture } from "./fixtures.ts";
import { TimeInForce } from "../fixtures/timeInForce.ts";

const { networkHelpers } = await network.connect();

type OrderIntent = {
  price: bigint;
  quantity: bigint;
  timeInForce: number;
};

describe("HashPowerPerpsDEX.createOrders (batch placement)", function () {
  it("empty intents array is a no-op", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { buyer, pc } = accounts;

    const tx = await perps.write.createOrders([[]], { account: buyer.account });
    const receipt = await pc.waitForTransactionReceipt({ hash: tx });
    assert.equal(receipt.status, "success");

    const created = parseEventLogs({
      logs: receipt.logs,
      abi: perps.abi,
      eventName: "OrderCreated",
    });
    assert.equal(created.length, 0);
    assert.equal((await perps.read.getUserOrders([buyer.account.address])).length, 0);
  });

  it("places multiple same-side orders in one call", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { buyer, pc } = accounts;

    const marketPrice = await perps.read.getMarketPrice();
    const step = config.minimumPriceIncrement;
    const qty = parseUnits("1", config.quantityDecimals);

    const intents: OrderIntent[] = [
      { price: marketPrice - step, quantity: qty, timeInForce: TimeInForce.GTC },
      { price: marketPrice - 2n * step, quantity: qty, timeInForce: TimeInForce.GTC },
      { price: marketPrice - 3n * step, quantity: qty, timeInForce: TimeInForce.GTC },
    ];

    const tx = await perps.write.createOrders([intents], { account: buyer.account });
    const receipt = await pc.waitForTransactionReceipt({ hash: tx });
    assert.equal(receipt.status, "success");

    const created = parseEventLogs({
      logs: receipt.logs,
      abi: perps.abi,
      eventName: "OrderCreated",
    });
    assert.equal(created.length, 3);
    for (const ev of created) {
      assert.equal(getAddress(ev.args.participant), getAddress(buyer.account.address));
    }

    const orders = await perps.read.getUserOrders([buyer.account.address]);
    assert.equal(orders.length, 3);
  });

  it("is cheaper than equivalent individual createOrder transactions", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { buyer, seller, pc } = accounts;

    const marketPrice = await perps.read.getMarketPrice();
    const step = config.minimumPriceIncrement;
    const qty = parseUnits("1", config.quantityDecimals);
    const N = 4;

    let baselineGas = 0n;
    for (let i = 0; i < N; i++) {
      const tx = await perps.write.createOrder(
        [marketPrice + BigInt(i + 1) * step, -qty, TimeInForce.GTC],
        { account: seller.account },
      );
      baselineGas += (await pc.waitForTransactionReceipt({ hash: tx })).gasUsed;
    }

    const intents: OrderIntent[] = [];
    for (let i = 0; i < N; i++) {
      intents.push({
        price: marketPrice - BigInt(i + 1) * step,
        quantity: qty,
        timeInForce: TimeInForce.GTC,
      });
    }
    const batchTx = await perps.write.createOrders([intents], { account: buyer.account });
    const batchGas = (await pc.waitForTransactionReceipt({ hash: batchTx })).gasUsed;

    assert.ok(
      batchGas < baselineGas,
      `createOrders (${batchGas}) should be cheaper than ${N} createOrder transactions (${baselineGas})`,
    );
  });
});
