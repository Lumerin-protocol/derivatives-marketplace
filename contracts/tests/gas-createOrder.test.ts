/**
 * Gas benchmark: createOrder (direct path only).
 * Logs gas per scenario to the console. Run:
 *   pnpm exec hardhat --network hardhat test tests/gas-createOrder.test.ts
 */
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { viem } from "hardhat";
import { parseUnits } from "viem";
import { deployPerpsWithCollateralFixture, deployPerpsWithOrdersFixture } from "./fixtures";

type PerpsCreateOrder = {
  write: { createOrder: (args: [bigint, bigint], opts: { account: { address: string } }) => Promise<`0x${string}`> };
};
type AccountLike = { account: { address: string } };

/** Execute createOrder and log gas used; if matchCount > 0, also log average gas per match. */
async function createOrderAndLogGas(
  perps: PerpsCreateOrder,
  publicClient: Awaited<ReturnType<typeof viem.getPublicClient>>,
  scenarioName: string,
  args: [bigint, bigint],
  account: { address: string },
  matchCount = 0,
) {
  const hash = await perps.write.createOrder(args, { account });
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

/** Place `count` sell orders at the same price (asks). Uses createOrder. */
async function placeAsksAtPrice(
  perps: PerpsCreateOrder,
  seller: AccountLike,
  price: bigint,
  qty: bigint,
  count: number,
) {
  for (let i = 0; i < count; i++) {
    await perps.write.createOrder([price, -qty], { account: seller.account });
  }
}

/** Place asks at multiple price levels: `levels` levels, `ordersPerLevel` orders each, from marketPrice + tick. */
async function placeAsksMultiLevel(
  perps: PerpsCreateOrder,
  seller: AccountLike,
  marketPrice: bigint,
  tick: bigint,
  qty: bigint,
  levels: number,
  ordersPerLevel: number,
) {
  for (let l = 0; l < levels; l++) {
    const price = marketPrice + BigInt(l + 1) * tick;
    for (let o = 0; o < ordersPerLevel; o++) {
      await perps.write.createOrder([price, -qty], { account: seller.account });
    }
  }
}

describe("Gas: createOrder", function () {
  let publicClient: Awaited<ReturnType<typeof viem.getPublicClient>>;

  before(async function () {
    publicClient = await viem.getPublicClient();
  });

  it("createOrder_restingOnly (no match)", async function () {
    const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { buyer } = accounts;
    const marketPrice = await perps.read.getMarketPrice();
    const price = marketPrice - config.minimumPriceIncrement;
    const quantity = parseUnits("1", config.quantityDecimals);

    await createOrderAndLogGas(
      perps,
      publicClient!,
      "createOrder_restingOnly (no match)",
      [price, quantity],
      buyer.account,
    );

    const orders = await perps.read.getUserOrders([buyer.account.address]);
    expect(orders.length).to.equal(1);
  });

  it("createOrder_1Match", async function () {
    const { contracts, accounts, config } = await loadFixture(deployPerpsWithOrdersFixture);
    const { perps } = contracts;
    const { buyer2 } = accounts;
    const { marketPrice, qty } = config;
    const tick = config.minimumPriceIncrement;
    const buyPrice = marketPrice + 2n * tick;

    await createOrderAndLogGas(perps, publicClient!, "createOrder_1Match", [buyPrice, qty], buyer2.account, 1);

    const position = await perps.read.getUserPosition([buyer2.account.address]);
    expect(position.netQuantity).to.equal(qty);
  });

  it("createOrder_3Matches (one price level)", async function () {
    const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { seller, buyer2 } = accounts;
    const marketPrice = await perps.read.getMarketPrice();
    const tick = config.minimumPriceIncrement;
    const qty = parseUnits("1", config.quantityDecimals);

    await perps.write.createOrder([marketPrice + tick, -qty], { account: seller.account });
    await perps.write.createOrder([marketPrice + tick, -qty], { account: seller.account });
    await perps.write.createOrder([marketPrice + tick, -qty], { account: seller.account });

    await createOrderAndLogGas(
      perps,
      publicClient!,
      "createOrder_3Matches (one price level)",
      [marketPrice + tick, qty * 3n],
      buyer2.account,
      3,
    );

    const position = await perps.read.getUserPosition([buyer2.account.address]);
    expect(position.netQuantity).to.equal(qty * 3n);
  });

  it("createOrder_10Matches_oneLevel", async function () {
    const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { seller, buyer2 } = accounts;
    const marketPrice = await perps.read.getMarketPrice();
    const tick = config.minimumPriceIncrement;
    const qty = parseUnits("1", config.quantityDecimals);

    await placeAsksAtPrice(perps, seller, marketPrice + tick, qty, 10);
    await createOrderAndLogGas(
      perps,
      publicClient!,
      "createOrder_10Matches_oneLevel",
      [marketPrice + tick, qty * 10n],
      buyer2.account,
      10,
    );

    const position = await perps.read.getUserPosition([buyer2.account.address]);
    expect(position.netQuantity).to.equal(qty * 10n);
  });

  it("createOrder_10Matches_5Levels", async function () {
    const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { seller, buyer2 } = accounts;
    const marketPrice = await perps.read.getMarketPrice();
    const tick = config.minimumPriceIncrement;
    const qty = parseUnits("1", config.quantityDecimals);

    await placeAsksMultiLevel(perps, seller, marketPrice, tick, qty, 5, 2);
    const totalQty = qty * 10n;
    await createOrderAndLogGas(
      perps,
      publicClient!,
      "createOrder_10Matches_5Levels",
      [marketPrice + 5n * tick, totalQty],
      buyer2.account,
      10,
    );

    const position = await perps.read.getUserPosition([buyer2.account.address]);
    expect(position.netQuantity).to.equal(totalQty);
  });

  it("createOrder_20Matches_oneLevel", async function () {
    const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { seller, buyer2 } = accounts;
    const marketPrice = await perps.read.getMarketPrice();
    const tick = config.minimumPriceIncrement;
    const qty = parseUnits("1", config.quantityDecimals);

    await placeAsksAtPrice(perps, seller, marketPrice + tick, qty, 20);
    await createOrderAndLogGas(
      perps,
      publicClient!,
      "createOrder_20Matches_oneLevel",
      [marketPrice + tick, qty * 20n],
      buyer2.account,
      20,
    );

    const position = await perps.read.getUserPosition([buyer2.account.address]);
    expect(position.netQuantity).to.equal(qty * 20n);
  });

  it("createOrder_20Matches_10Levels", async function () {
    const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { seller, buyer2 } = accounts;
    const marketPrice = await perps.read.getMarketPrice();
    const tick = config.minimumPriceIncrement;
    const qty = parseUnits("1", config.quantityDecimals);

    await placeAsksMultiLevel(perps, seller, marketPrice, tick, qty, 10, 2);
    const totalQty = qty * 20n;
    await createOrderAndLogGas(
      perps,
      publicClient!,
      "createOrder_20Matches_10Levels",
      [marketPrice + 10n * tick, totalQty],
      buyer2.account,
      20,
    );

    const position = await perps.read.getUserPosition([buyer2.account.address]);
    expect(position.netQuantity).to.equal(totalQty);
  });

  it("createOrder_32Matches_oneLevel", async function () {
    const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const { seller, buyer2 } = accounts;
    const marketPrice = await perps.read.getMarketPrice();
    const tick = config.minimumPriceIncrement;
    const qty = parseUnits("1", config.quantityDecimals);

    await placeAsksAtPrice(perps, seller, marketPrice + tick, qty, 32);
    await createOrderAndLogGas(
      perps,
      publicClient!,
      "createOrder_32Matches_oneLevel",
      [marketPrice + tick, qty * 32n],
      buyer2.account,
      32,
    );

    const position = await perps.read.getUserPosition([buyer2.account.address]);
    expect(position.netQuantity).to.equal(qty * 32n);
  });
});
