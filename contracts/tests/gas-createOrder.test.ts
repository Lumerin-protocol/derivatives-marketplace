/**
 * Gas benchmark: createOrder (direct path only).
 * Logs gas per scenario to the console. Run:
 *   pnpm exec hardhat --network hardhat test tests/gas-createOrder.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits, type Account, type Client, type PublicClient } from "viem";
import { deployPerpsWithCollateralFixture, deployPerpsWithOrdersFixture } from "./fixtures.ts";
import { TimeInForce } from "../fixtures/timeInForce.ts";

const { viem, networkHelpers } = await network.getOrCreate();

function getPerps(addr: `0x${string}`) {
  return viem.getContractAt("HashPowerPerpsDEX", addr);
}

type Perps = Awaited<ReturnType<typeof getPerps>>

async function createOrderAndLogGas(
  perps: Perps,
  publicClient: PublicClient,
  scenarioName: string,
  args: [bigint, bigint],
  account: Account,
  matchCount = 0,
) {
  const hash = await perps.write.createOrder([...args, TimeInForce.GTC], { account: account });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const gas = Number(receipt.gasUsed);
  const totalLine = `  ${scenarioName}: ${gas.toLocaleString()} gas`;
  if (matchCount > 0) {
    const avgPerMatch = Math.round(gas / matchCount);
    console.log(`${totalLine} (avg per match: ${avgPerMatch.toLocaleString()} gas)`);
  } else {
    console.log(totalLine);
  }
}

async function placeAsksAtPrice(perps: Perps, seller: Client, price: bigint, qty: bigint, count: number) {
  for (let i = 0; i < count; i++) {
    await perps.write.createOrder([price, -qty, TimeInForce.GTC], { account: seller.account });
  }
}

async function placeAsksMultiLevel(
  perps: Perps,
  seller: Client,
  marketPrice: bigint,
  tick: bigint,
  qty: bigint,
  levels: number,
  ordersPerLevel: number,
) {
  for (let l = 0; l < levels; l++) {
    const price = marketPrice + BigInt(l + 1) * tick;
    for (let o = 0; o < ordersPerLevel; o++) {
      await perps.write.createOrder([price, -qty, TimeInForce.GTC], { account: seller.account });
    }
  }
}

describe("Gas: createOrder", function () {
  it("createOrder_restingOnly (no match)", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { buyer, pc } = accounts;
    const marketPrice = await perps.read.getMarketPrice();
    const price = marketPrice - config.minimumPriceIncrement;
    const quantity = parseUnits("1", config.quantityDecimals);

    await createOrderAndLogGas(perps, pc, "createOrder_restingOnly (no match)", [price, quantity], buyer.account);

    const orders = await perps.read.getUserOrders([buyer.account.address]);
    assert.equal(orders.length, 1);
  });

  it("createOrder_1Match", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithOrdersFixture);
    const { perps } = contracts;
    const { buyer2, pc } = accounts;
    const { marketPrice, qty } = config;
    const tick = config.minimumPriceIncrement;
    const buyPrice = marketPrice + 2n * tick;

    await createOrderAndLogGas(perps, pc, "createOrder_1Match", [buyPrice, qty], buyer2.account, 1);

    const position = await perps.read.getUserPosition([buyer2.account.address]);
    assert.equal(position.netQuantity, qty);
  });

  it("createOrder_portfolioReducingResting", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { seller, buyer2, pc } = accounts;
    const marketPrice = await perps.read.getMarketPrice();
    const tick = config.minimumPriceIncrement;
    const qty = parseUnits("1", config.quantityDecimals);

    await perps.write.createOrder([marketPrice, -qty, TimeInForce.GTC], { account: seller.account });
    await perps.write.createOrder([marketPrice, qty, TimeInForce.GTC], { account: buyer2.account });
    await createOrderAndLogGas(
      perps,
      pc,
      "createOrder_portfolioReducingResting",
      [marketPrice + tick, -qty],
      buyer2.account,
    );

    const orders = await perps.read.getUserOrders([buyer2.account.address]);
    assert.equal(orders.length, 1);
  });

  it("createOrder_portfolioReducingResting_50ExistingOrders", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { seller, buyer2, pc } = accounts;
    const marketPrice = await perps.read.getMarketPrice();
    const tick = config.minimumPriceIncrement;
    const qty = parseUnits("1", config.quantityDecimals);

    await perps.write.createOrder([marketPrice, -qty, TimeInForce.GTC], { account: seller.account });
    await perps.write.createOrder([marketPrice, qty, TimeInForce.GTC], { account: buyer2.account });
    await perps.write.createOrders([
      Array.from({ length: 50 }, () => ({
        price: marketPrice - tick,
        quantity: qty,
        timeInForce: TimeInForce.GTC,
      })),
    ], { account: buyer2.account });

    await createOrderAndLogGas(
      perps,
      pc,
      "createOrder_portfolioReducingResting_50ExistingOrders",
      [marketPrice + tick, -qty],
      buyer2.account,
    );
  });

  it("createOrder_3Matches (one price level)", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { seller, buyer2, pc } = accounts;
    const marketPrice = await perps.read.getMarketPrice();
    const tick = config.minimumPriceIncrement;
    const qty = parseUnits("1", config.quantityDecimals);

    await perps.write.createOrder([marketPrice + tick, -qty, TimeInForce.GTC], { account: seller.account });
    await perps.write.createOrder([marketPrice + tick, -qty, TimeInForce.GTC], { account: seller.account });
    await perps.write.createOrder([marketPrice + tick, -qty, TimeInForce.GTC], { account: seller.account });

    await createOrderAndLogGas(perps, pc, "createOrder_3Matches (one price level)", [marketPrice + tick, qty * 3n], buyer2.account, 3);

    const position = await perps.read.getUserPosition([buyer2.account.address]);
    assert.equal(position.netQuantity, qty * 3n);
  });

  it("createOrder_10Matches_oneLevel", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { seller, buyer2, pc } = accounts;
    const marketPrice = await perps.read.getMarketPrice();
    const tick = config.minimumPriceIncrement;
    const qty = parseUnits("1", config.quantityDecimals);

    await placeAsksAtPrice(perps, seller, marketPrice + tick, qty, 10);
    await createOrderAndLogGas(perps, pc, "createOrder_10Matches_oneLevel", [marketPrice + tick, qty * 10n], buyer2.account, 10);

    const position = await perps.read.getUserPosition([buyer2.account.address]);
    assert.equal(position.netQuantity, qty * 10n);
  });

  it("createOrder_10Matches_5Levels", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { seller, buyer2, pc } = accounts;
    const marketPrice = await perps.read.getMarketPrice();
    const tick = config.minimumPriceIncrement;
    const qty = parseUnits("1", config.quantityDecimals);

    await placeAsksMultiLevel(perps, seller, marketPrice, tick, qty, 5, 2);
    const totalQty = qty * 10n;
    await createOrderAndLogGas(perps, pc, "createOrder_10Matches_5Levels", [marketPrice + 5n * tick, totalQty], buyer2.account, 10);

    const position = await perps.read.getUserPosition([buyer2.account.address]);
    assert.equal(position.netQuantity, totalQty);
  });

  it("createOrder_20Matches_oneLevel", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { seller, buyer2, pc } = accounts;
    const marketPrice = await perps.read.getMarketPrice();
    const tick = config.minimumPriceIncrement;
    const qty = parseUnits("1", config.quantityDecimals);

    await placeAsksAtPrice(perps, seller, marketPrice + tick, qty, 20);
    await createOrderAndLogGas(perps, pc, "createOrder_20Matches_oneLevel", [marketPrice + tick, qty * 20n], buyer2.account, 20);

    const position = await perps.read.getUserPosition([buyer2.account.address]);
    assert.equal(position.netQuantity, qty * 20n);
  });

  it("createOrder_20Matches_10Levels", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { seller, buyer2, pc } = accounts;
    const marketPrice = await perps.read.getMarketPrice();
    const tick = config.minimumPriceIncrement;
    const qty = parseUnits("1", config.quantityDecimals);

    await placeAsksMultiLevel(perps, seller, marketPrice, tick, qty, 10, 2);
    const totalQty = qty * 20n;
    await createOrderAndLogGas(perps, pc, "createOrder_20Matches_10Levels", [marketPrice + 10n * tick, totalQty], buyer2.account, 20);

    const position = await perps.read.getUserPosition([buyer2.account.address]);
    assert.equal(position.netQuantity, totalQty);
  });

  it("createOrder_32Matches_oneLevel", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { seller, buyer2, pc } = accounts;
    const marketPrice = await perps.read.getMarketPrice();
    const tick = config.minimumPriceIncrement;
    const qty = parseUnits("1", config.quantityDecimals);

    await placeAsksAtPrice(perps, seller, marketPrice + tick, qty, 32);
    await createOrderAndLogGas(perps, pc, "createOrder_32Matches_oneLevel", [marketPrice + tick, qty * 32n], buyer2.account, 32);

    const position = await perps.read.getUserPosition([buyer2.account.address]);
    assert.equal(position.netQuantity, qty * 32n);
  });
});
