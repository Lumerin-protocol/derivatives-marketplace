import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  numberToHex,
  type Address,
  type PublicClient,
} from "viem";
import { TimeInForce } from "../fixtures/timeInForce.ts";
import { deployPerpsWithCollateralFixture } from "./fixtures.ts";
import {
  getAverageEntryPrice,
} from "./lib/viewHelpers.ts";

const { viem, networkHelpers } = await network.connect();
const SCALE = 1_000_000n;
const FUNDING_SNAPSHOT_MAPPING_SLOT = 22n;

function signedValue(price: bigint, quantity: bigint) {
  return (price * quantity) / SCALE;
}

function derivedAverage(entryValue: bigint, quantity: bigint) {
  if (quantity === 0n) return 0n;
  const absEntry = entryValue < 0n ? -entryValue : entryValue;
  const absQty = quantity < 0n ? -quantity : quantity;
  return (absEntry * SCALE) / absQty;
}

function mappingElementSlot(participant: Address, mappingSlot: bigint) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [participant, mappingSlot],
    ),
  );
}

async function readFundingSnapshot(
  pc: PublicClient,
  proxy: Address,
  participant: Address,
) {
  const value = await pc.getStorageAt({
    address: proxy,
    slot: numberToHex(
      BigInt(mappingElementSlot(participant, FUNDING_SNAPSHOT_MAPPING_SLOT)),
      { size: 32 },
    ),
  });
  return value ? BigInt(value) : 0n;
}

async function installHarness(
  data: Awaited<ReturnType<typeof deployPerpsWithCollateralFixture>>,
) {
  const { perps, vault } = data.contracts;
  const { owner } = data.accounts;
  const implementation = await viem.deployContract(
    "HashPowerPerpsDEXMigrationHarness",
    [vault.address],
  );
  await perps.write.upgradeToAndCall([implementation.address, "0x"], {
    account: owner.account,
  });
  return viem.getContractAt("HashPowerPerpsDEXMigrationHarness", perps.address);
}

describe("HashPowerPerpsDEX exact entry-value upgrade-and-reset", function () {
  it("atomically clears complete legacy long, short, flat, order, and funding state", async function () {
    const data = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { contracts, accounts, config } = data;
    const { vault } = contracts;
    const { owner, buyer, seller, buyer2, pc } = accounts;
    const harness = await installHarness(data);
    await harness.write.initializeV3({ account: owner.account });
    const market = await harness.read.getMarketPrice();
    const tick = config.minimumPriceIncrement;

    await harness.write.createOrder(
      [market - tick, 100_000n, TimeInForce.GTC],
      { account: buyer.account },
    );
    await harness.write.createOrder(
      [market + tick, -200_000n, TimeInForce.GTC],
      { account: seller.account },
    );
    await harness.write.createOrder(
      [market - 2n * tick, 300_000n, TimeInForce.GTC],
      { account: buyer2.account },
    );
    await harness.write.clearOrderAggregateCache([buyer.account.address]);
    await harness.write.setLegacyPosition([
      buyer.account.address,
      1_500_001n,
      market - 3n * tick,
    ]);
    await harness.write.setLegacyPosition([
      seller.account.address,
      -2_250_003n,
      market + 4n * tick,
    ]);
    await harness.write.setLegacyPosition([
      buyer2.account.address,
      0n,
      market,
    ]);
    for (const participant of [buyer, seller, buyer2]) {
      await harness.write.setFundingSnapshot([
        participant.account.address,
        123_456n,
      ]);
    }

    const implementation = await viem.deployContract("HashPowerPerpsDEX", [
      vault.address,
    ]);
    const participants = [
      buyer.account.address,
      seller.account.address,
      buyer2.account.address,
    ] as const;
    const resetData = encodeFunctionData({
      abi: implementation.abi,
      functionName: "resetState",
      args: [participants],
    });
    await harness.write.upgradeToAndCall([implementation.address, resetData], {
      account: owner.account,
    });
    const perps = await viem.getContractAt(
      "HashPowerPerpsDEX",
      harness.address,
    );

    for (const participant of participants) {
      assert.deepEqual(await perps.read.getUserPosition([participant]), {
        netQuantity: 0n,
        netEntryValue: 0n,
      });
      assert.deepEqual(await perps.read.getUserOrders([participant]), []);
      assert.equal(await perps.read.getPendingFunding([participant]), 0n);
      assert.equal(
        await readFundingSnapshot(pc, perps.address, participant),
        0n,
      );
    }
  });

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

  it("resetState clears a canonical exact-entry position", async function () {
    const data = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { contracts, accounts } = data;
    const { perps } = contracts;
    const { owner, buyer, seller } = accounts;
    const price = await perps.read.getMarketPrice();
    const quantity = 1_000_000n;
    await perps.write.createOrder(
      [price, -quantity, TimeInForce.GTC],
      { account: seller.account },
    );
    await perps.write.createOrder(
      [price, quantity, TimeInForce.GTC],
      { account: buyer.account },
    );

    await perps.write.resetState([[buyer.account.address]], {
      account: owner.account,
    });
    assert.deepEqual(await perps.read.getUserPosition([buyer.account.address]), {
      netQuantity: 0n,
      netEntryValue: 0n,
    });
  });
});
