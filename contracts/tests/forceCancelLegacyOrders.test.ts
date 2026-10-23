import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { type Address, encodeAbiParameters, encodeFunctionData, keccak256, numberToHex } from "viem";
import { TimeInForce } from "../fixtures/timeInForce.ts";
import { deployPerpsWithPositionsFixture } from "./fixtures.ts";

const { viem, networkHelpers } = await network.connect();

/** `userRestingOrderAggregate`, frozen by `scripts/HashPowerPerpsDEX.storage-layout.json`. */
const RESTING_ORDER_AGGREGATE_SLOT = 32n;
const AGGREGATE_FIELDS = 6n;
const EMPTY_AGGREGATE = { buyQty: 0n, sellQty: 0n, buyPQ: 0n, buyP2Q: 0n, sellPQ: 0n, sellP2Q: 0n };

/** Empty the user's 6.10 aggregate, as it is for orders placed before the upgrade. */
async function eraseAggregate(proxy: Address, user: Address) {
  const base = BigInt(
    keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [user, RESTING_ORDER_AGGREGATE_SLOT])),
  );
  for (let i = 0n; i < AGGREGATE_FIELDS; i++) {
    await networkHelpers.setStorageAt(proxy, numberToHex(base + i, { size: 32 }), 0n);
  }
}

async function legacyBookFixture(conn: Parameters<typeof deployPerpsWithPositionsFixture>[0]) {
  const data = await deployPerpsWithPositionsFixture(conn);
  const { perps } = data.contracts;
  const { buyer, seller } = data.accounts;
  const tick = data.config.minimumPriceIncrement;
  const mark = data.config.marketPrice;
  await perps.write.createOrder([mark - tick, 2n, TimeInForce.GTC], { account: buyer.account });
  await perps.write.createOrder([mark + tick, -3n, TimeInForce.GTC], { account: buyer.account });
  await perps.write.createOrder([mark + 2n * tick, -1n, TimeInForce.GTC], { account: seller.account });
  for (const user of [buyer, seller]) {
    await eraseAggregate(perps.address, user.account.address);
    assert.deepEqual(await perps.read.getOrderAggregate([user.account.address]), EMPTY_AGGREGATE);
    assert.ok((await perps.read.getUserOrders([user.account.address])).length > 0);
  }
  return data;
}

async function assertBookCleared(data: Awaited<ReturnType<typeof legacyBookFixture>>) {
  const { perps } = data.contracts;
  for (const user of [data.accounts.buyer, data.accounts.seller]) {
    assert.deepEqual(await perps.read.getUserOrders([user.account.address]), []);
    assert.deepEqual(await perps.read.getOrderAggregate([user.account.address]), EMPTY_AGGREGATE);
  }
  const [bids, asks] = await perps.read.getOrderBookPrices([200n]);
  assert.deepEqual([...bids, ...asks], []);
}

describe("HashPowerPerpsDEX.forceCancelOrders on orders predating the 6.10 aggregate", function () {
  it("removes them although their quantities are missing from the aggregate", async function () {
    const data = await networkHelpers.loadFixture(legacyBookFixture);
    const { perps } = data.contracts;
    const { owner, buyer, seller } = data.accounts;

    await perps.write.forceCancelOrders([[buyer.account.address, seller.account.address]], {
      account: owner.account,
    });

    await assertBookCleared(data);
  });

  it("runs atomically as the upgrade call", async function () {
    const data = await networkHelpers.loadFixture(legacyBookFixture);
    const { perps, vault } = data.contracts;
    const { owner, buyer, seller } = data.accounts;
    const implementation = await viem.deployContract("HashPowerPerpsDEX", [vault.address]);
    const cancelAll = encodeFunctionData({
      abi: implementation.abi,
      functionName: "forceCancelOrders",
      args: [[buyer.account.address, seller.account.address]],
    });

    await perps.write.upgradeToAndCall([implementation.address, cancelAll], { account: owner.account });

    await assertBookCleared(data);
  });
});
