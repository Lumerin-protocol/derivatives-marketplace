import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { assertAbiFunctionCoverage, GasRecorder, writeSnapshot } from "@lsheva/evm-gas-benchmark";
import { network } from "hardhat";
import { type Address, encodeFunctionData, type Hash, type PublicClient, parseUnits, zeroAddress } from "viem";
import { HashPowerPerpsDEXAbi } from "../../abi/HashPowerPerpsDEX.ts";
import { TimeInForce } from "../../fixtures/timeInForce.ts";
import { deployPerpsGasFixture } from "./fixtures.ts";

const { viem, networkHelpers } = await network.getOrCreate();
const gas = new GasRecorder();
const SNAPSHOT_PATH = fileURLToPath(new URL("../../benchmarks/perps-gas.json", import.meta.url));

type GasFixture = Awaited<ReturnType<typeof deployPerpsGasFixture>>;
type Perps = GasFixture["contracts"]["perps"];
type Wallet = GasFixture["accounts"]["seller"];
type OrderIntent = { price: bigint; quantity: bigint; timeInForce: number };

const exclusions = {
  "initialize(address,address)":
    "The deployed UUPS proxy is already initialized, while the implementation constructor disables initializers; no successful independent call exists after deployment.",
  "proxiableUUID()":
    "OpenZeppelin UUPS marks proxiableUUID notDelegated, so it intentionally reverts through the deployed proxy and is callable only on the implementation.",
} as const;

async function fresh(): Promise<GasFixture> {
  return networkHelpers.loadFixture(deployPerpsGasFixture);
}

async function recordTransaction(pc: PublicClient, signature: string, scenario: string, transaction: Promise<Hash>) {
  const receipt = await pc.waitForTransactionReceipt({ hash: await transaction });
  assert.equal(receipt.status, "success");
  gas.recordTransaction({ function: signature, scenario }, receipt);
}

async function recordView(
  pc: PublicClient,
  perps: Perps,
  signature: string,
  functionName: string,
  args: readonly unknown[] = [],
  scenario = "representative",
  account?: Address,
) {
  const data = encodeFunctionData({ abi: HashPowerPerpsDEXAbi, functionName, args } as never);
  const estimated = await pc.estimateGas({ to: perps.address, data, ...(account === undefined ? {} : { account }) });
  gas.recordViewEstimate({ function: signature, scenario }, estimated);
}

/** Deposit trading collateral; the fixture gives each trader 1,000 USDC to spend. */
async function fund(data: GasFixture, wallets: Wallet[], amount = parseUnits("1000", 6)) {
  for (const wallet of wallets) {
    await data.contracts.vault.write.deposit([amount], { account: wallet.account });
  }
}

function units(data: GasFixture, contracts: string) {
  return parseUnits(contracts, data.config.quantityDecimals);
}

/** Seller short and buyer long `quantity` at the mark. */
async function openPosition(data: GasFixture, quantity: bigint) {
  const { perps } = data.contracts;
  const { seller, buyer } = data.accounts;
  const price = await perps.read.getMarketPrice();
  await perps.write.createOrder([price, -quantity, TimeInForce.GTC], { account: seller.account });
  await perps.write.createOrder([price, quantity, TimeInForce.GTC], { account: buyer.account });
  return price;
}

/** `count` resting intents one tick apart, walking away from the mark on `quantity`'s side. */
function ladder(mark: bigint, tick: bigint, count: number, quantity: bigint, start = 1): OrderIntent[] {
  const step = quantity > 0n ? -tick : tick;
  return Array.from({ length: count }, (_, i) => ({
    price: mark + BigInt(start + i) * step,
    quantity,
    timeInForce: TimeInForce.GTC,
  }));
}

async function benchmarkViews() {
  const data = await fresh();
  const { perps } = data.contracts;
  const { seller, buyer, pc } = data.accounts;
  const tick = data.config.minimumPriceIncrement;
  const one = units(data, "1");
  await fund(data, [seller, buyer]);
  const mark = await openPosition(data, one);
  await perps.write.createOrder([mark - tick, one, TimeInForce.GTC], { account: buyer.account });
  await perps.write.createOrder([mark + tick, -one, TimeInForce.GTC], { account: seller.account });
  const [orderId] = await perps.read.getUserOrders([buyer.account.address]);
  const user = buyer.account.address;

  const views: Array<[string, string, readonly unknown[]]> = [
    ["BACKSTOP()", "BACKSTOP", []],
    ["CONTRACT_SIZE_HPS_DAY()", "CONTRACT_SIZE_HPS_DAY", []],
    ["FUNDING_DECIMALS()", "FUNDING_DECIMALS", []],
    ["MAX_ORACLE_STALENESS()", "MAX_ORACLE_STALENESS", []],
    ["MAX_ORDERS_PER_PARTICIPANT()", "MAX_ORDERS_PER_PARTICIPANT", []],
    ["MAX_PRICE()", "MAX_PRICE", []],
    ["MAX_PRICE_LEVELS_PER_SIDE()", "MAX_PRICE_LEVELS_PER_SIDE", []],
    ["QUANTITY_DECIMALS()", "QUANTITY_DECIMALS", []],
    ["UPGRADE_INTERFACE_VERSION()", "UPGRADE_INTERFACE_VERSION", []],
    ["VERSION()", "VERSION", []],
    ["collectedFeesBalance()", "collectedFeesBalance", []],
    ["cumulativeFundingPerUnit()", "cumulativeFundingPerUnit", []],
    ["fundingPeriod()", "fundingPeriod", []],
    ["fundingRateMaxBps()", "fundingRateMaxBps", []],
    ["getMarketPrice()", "getMarketPrice", []],
    ["getOrder(bytes32)", "getOrder", [orderId]],
    ["getOrderAggregate(address)", "getOrderAggregate", [user]],
    ["getOrderBookPrices(uint256)", "getOrderBookPrices", [200n]],
    ["getPendingFunding(address)", "getPendingFunding", [user]],
    ["getQuantityAtPrice(uint256,bool)", "getQuantityAtPrice", [mark - tick, true]],
    ["getRiskView(address)", "getRiskView", [user]],
    ["getUnrealizedPnl(address)", "getUnrealizedPnl", [user]],
    ["getUserOrders(address)", "getUserOrders", [user]],
    ["getUserPosition(address)", "getUserPosition", [user]],
    ["hasRestingOrderDelta(address)", "hasRestingOrderDelta", [user]],
    ["hook()", "hook", []],
    ["lastFundingUpdateTime()", "lastFundingUpdateTime", []],
    ["liquidationFeeBps()", "liquidationFeeBps", []],
    ["liquidatorShareBps()", "liquidatorShareBps", []],
    ["makerFeeBps()", "makerFeeBps", []],
    ["minimumMarginPerOrder()", "minimumMarginPerOrder", []],
    ["minimumPriceIncrement()", "minimumPriceIncrement", []],
    ["owner()", "owner", []],
    ["portfolioMargin()", "portfolioMargin", []],
    ["priceOracle()", "priceOracle", []],
    ["simulateOrder(uint256,int256)", "simulateOrder", [mark + tick, one]],
    ["takerFeeBps()", "takerFeeBps", []],
    ["vault()", "vault", []],
  ];
  for (const [signature, functionName, args] of views) {
    await recordView(pc, perps, signature, functionName, args);
  }
}

/** Risk view cost as a participant's resting book grows, up to `MAX_ORDERS_PER_PARTICIPANT`. */
async function benchmarkScaledRiskViews() {
  for (const count of [0, 1, 10, 50, 100]) {
    const data = await fresh();
    const { perps } = data.contracts;
    const { buyer, pc } = data.accounts;
    await fund(data, [buyer]);
    const mark = await perps.read.getMarketPrice();
    const intents = ladder(mark, data.config.minimumPriceIncrement, count, units(data, "0.1"));
    for (let i = 0; i < intents.length; i += 10) {
      await perps.write.createOrders([intents.slice(i, i + 10)], { account: buyer.account });
    }
    await recordView(pc, perps, "getRiskView(address)", "getRiskView", [buyer.account.address], `${count}-orders`);
  }
}

async function benchmarkOrderPlacement() {
  {
    const data = await fresh();
    const { perps } = data.contracts;
    const { buyer, pc } = data.accounts;
    await fund(data, [buyer]);
    const mark = await perps.read.getMarketPrice();
    const tick = data.config.minimumPriceIncrement;
    const one = units(data, "1");
    await recordTransaction(
      pc,
      "createOrder(uint256,int256,uint8)",
      "resting order, new level",
      perps.write.createOrder([mark - tick, one, TimeInForce.GTC], { account: buyer.account }),
    );
    await recordTransaction(
      pc,
      "createOrder(uint256,int256,uint8)",
      "resting order, existing level",
      perps.write.createOrder([mark - tick, one, TimeInForce.GTC], { account: buyer.account }),
    );
  }
  {
    const data = await fresh();
    const { perps } = data.contracts;
    const { seller, buyer, pc } = data.accounts;
    await fund(data, [seller, buyer]);
    const mark = await perps.read.getMarketPrice();
    const one = units(data, "1");
    await perps.write.createOrder([mark, -one, TimeInForce.GTC], { account: seller.account });
    await recordTransaction(
      pc,
      "createOrder(uint256,int256,uint8)",
      "full match against one maker",
      perps.write.createOrder([mark, one, TimeInForce.GTC], { account: buyer.account }),
    );
  }
  {
    const data = await fresh();
    const { perps } = data.contracts;
    const { seller, buyer, pc } = data.accounts;
    await fund(data, [seller, buyer]);
    const mark = await perps.read.getMarketPrice();
    const tick = data.config.minimumPriceIncrement;
    const one = units(data, "1");
    await perps.write.createOrder([mark, -one, TimeInForce.GTC], { account: seller.account });
    await perps.write.createOrder([mark + tick, -one, TimeInForce.GTC], { account: seller.account });
    await recordTransaction(
      pc,
      "createOrder(uint256,int256,uint8)",
      "two-level fill",
      perps.write.createOrder([mark + tick, 2n * one, TimeInForce.GTC], { account: buyer.account }),
    );
  }
  for (const size of [1, 5, 10]) {
    const data = await fresh();
    const { perps } = data.contracts;
    const { seller, pc } = data.accounts;
    await fund(data, [seller]);
    const mark = await perps.read.getMarketPrice();
    await recordTransaction(
      pc,
      "createOrders((uint256,int256,uint8)[])",
      `batch-${size}`,
      perps.write.createOrders([ladder(mark, data.config.minimumPriceIncrement, size, -units(data, "1"))], {
        account: seller.account,
      }),
    );
  }
}

async function benchmarkOrderMaintenance() {
  const restingBook = async () => {
    const data = await fresh();
    const { perps } = data.contracts;
    const { buyer } = data.accounts;
    await fund(data, [buyer]);
    const mark = await perps.read.getMarketPrice();
    await perps.write.createOrders([ladder(mark, data.config.minimumPriceIncrement, 3, units(data, "2"))], {
      account: buyer.account,
    });
    const ids = await perps.read.getUserOrders([buyer.account.address]);
    return { data, mark, ids };
  };
  {
    const { data, ids } = await restingBook();
    const { perps } = data.contracts;
    const { buyer, pc } = data.accounts;
    await recordTransaction(
      pc,
      "cancelOrder(bytes32)",
      "resting order",
      perps.write.cancelOrder([ids[0]], { account: buyer.account }),
    );
  }
  {
    const { data, ids } = await restingBook();
    const { perps } = data.contracts;
    const { buyer, pc } = data.accounts;
    await recordTransaction(
      pc,
      "reduceOrderSize(bytes32,int256)",
      "two-to-one",
      perps.write.reduceOrderSize([ids[0], units(data, "1")], { account: buyer.account }),
    );
  }
  {
    const { data, mark, ids } = await restingBook();
    const { perps } = data.contracts;
    const { buyer, pc } = data.accounts;
    const tick = data.config.minimumPriceIncrement;
    await recordTransaction(
      pc,
      "updateOrders(bytes32[],(bytes32,int256)[],(uint256,int256,uint8)[])",
      "cancel-1-reduce-1-create-1",
      perps.write.updateOrders(
        [
          [ids[0]],
          [{ orderId: ids[1], newQuantity: units(data, "1") }],
          [{ price: mark - 10n * tick, quantity: units(data, "1"), timeInForce: TimeInForce.GTC }],
        ],
        { account: buyer.account },
      ),
    );
  }
  {
    const { data, ids } = await restingBook();
    const { perps } = data.contracts;
    const { buyer, pc } = data.accounts;
    await recordTransaction(
      pc,
      "updateOrders(bytes32[],(bytes32,int256)[],(uint256,int256,uint8)[])",
      "cancel-only",
      perps.write.updateOrders([[ids[0]], [], []], { account: buyer.account }),
    );
  }
}

/** Seller short one contract on minimum collateral; doubling the mark leaves it underwater. */
async function underwaterSeller(withRestingOrders: boolean) {
  const data = await fresh();
  const { perps, priceOracle, vault } = data.contracts;
  const { owner, seller, buyer } = data.accounts;
  const one = units(data, "1");
  const mark = await perps.read.getMarketPrice();
  const tick = data.config.minimumPriceIncrement;
  const minimum = data.utils.getMinimumCollateral(mark, one);
  await perps.write.setLiquidationFeeBps([100], { account: owner.account });
  await vault.write.deposit([withRestingOrders ? minimum * 2n : minimum], { account: seller.account });
  await vault.write.deposit([minimum * 3n], { account: buyer.account });
  await openPosition(data, one);
  if (withRestingOrders) {
    const rest = units(data, "0.1");
    await perps.write.createOrder([mark + 5n * tick, -rest, TimeInForce.GTC], { account: seller.account });
    await perps.write.createOrder([mark + 10n * tick, -rest, TimeInForce.GTC], { account: seller.account });
  }
  await priceOracle.write.setPrice([mark * 2n, data.config.oracle.decimals]);
  return data;
}

async function benchmarkLiquidations() {
  {
    const data = await underwaterSeller(false);
    const { perps } = data.contracts;
    const { seller, buyer2, pc } = data.accounts;
    await recordTransaction(
      pc,
      "liquidatePosition(address,uint256)",
      "full close, no orders",
      perps.write.liquidatePosition([seller.account.address, units(data, "1")], { account: buyer2.account }),
    );
  }
  {
    const data = await underwaterSeller(false);
    const { perps } = data.contracts;
    const { seller, buyer2, pc } = data.accounts;
    await recordTransaction(
      pc,
      "liquidatePosition(address,uint256)",
      "partial close",
      perps.write.liquidatePosition([seller.account.address, units(data, "0.5")], { account: buyer2.account }),
    );
  }
  {
    const data = await underwaterSeller(true);
    const { perps } = data.contracts;
    const { seller, buyer2, pc } = data.accounts;
    const [orderId] = await perps.read.getUserOrders([seller.account.address]);
    await recordTransaction(
      pc,
      "liquidateOrder(address,bytes32)",
      "one underwater resting order",
      perps.write.liquidateOrder([seller.account.address, orderId], { account: buyer2.account }),
    );
  }
  {
    const data = await underwaterSeller(true);
    const { perps } = data.contracts;
    const { seller, buyer2, pc } = data.accounts;
    const ids = await perps.read.getUserOrders([seller.account.address]);
    await recordTransaction(
      pc,
      "liquidateOrders(address,bytes32[])",
      "batch-2",
      perps.write.liquidateOrders([seller.account.address, [...ids]], { account: buyer2.account }),
    );
  }
  {
    const data = await fresh();
    const { perps, vault } = data.contracts;
    const { owner, seller, buyer, pc } = data.accounts;
    await fund(data, [seller, buyer]);
    await openPosition(data, units(data, "1"));
    await vault.write.halt({ account: owner.account });
    await recordTransaction(
      pc,
      "forceClosePositions(address[])",
      "two users at the mark while halted",
      perps.write.forceClosePositions([[seller.account.address, buyer.account.address]], {
        account: owner.account,
      }),
    );
  }
  {
    // A full liquidation hands the seller's short to the backstop; a resting ask lets it cover.
    const data = await underwaterSeller(false);
    const { perps, vault } = data.contracts;
    const { owner, seller, buyer, buyer2, pc } = data.accounts;
    await perps.write.liquidatePosition([seller.account.address, units(data, "1")], { account: buyer2.account });
    await vault.write.setBackstopParams([100, 10], { account: owner.account });
    const mark = await perps.read.getMarketPrice();
    await perps.write.createOrder([mark, -units(data, "1"), TimeInForce.GTC], { account: buyer.account });
    await recordTransaction(
      pc,
      "unwindBackstop(uint256)",
      "buy one contract from a resting ask",
      perps.write.unwindBackstop([units(data, "1")], { account: buyer2.account }),
    );
  }
}

async function benchmarkFunding() {
  const data = await fresh();
  const { perps } = data.contracts;
  const { owner, seller, buyer, pc } = data.accounts;
  const tick = data.config.minimumPriceIncrement;
  await fund(data, [seller, buyer]);
  await perps.write.setFundingParameters([100n, 86400n], { account: owner.account });
  const mark = await openPosition(data, units(data, "1"));
  await perps.write.createOrder([mark + tick, units(data, "1"), TimeInForce.GTC], { account: buyer.account });
  await perps.write.createOrder([mark + 3n * tick, -units(data, "1"), TimeInForce.GTC], {
    account: seller.account,
  });
  await networkHelpers.time.increase(3600);
  await recordTransaction(pc, "updateFunding()", "two-sided book after an hour", perps.write.updateFunding());
}

async function benchmarkAdminAndLifecycle() {
  const admin = async (signature: string, scenario: string, send: (data: GasFixture) => Promise<Hash>) => {
    const data = await fresh();
    await recordTransaction(data.accounts.pc, signature, scenario, send(data));
  };
  const owner = (data: GasFixture) => ({ account: data.accounts.owner.account });

  await admin("setFundingParameters(uint256,uint256)", "100bps-1day", (d) =>
    d.contracts.perps.write.setFundingParameters([100n, 86400n], owner(d)),
  );
  await admin("setHook(address)", "clear", (d) => d.contracts.perps.write.setHook([zeroAddress], owner(d)));
  await admin("setLiquidationFeeBps(uint16)", "to-50", (d) =>
    d.contracts.perps.write.setLiquidationFeeBps([50], owner(d)),
  );
  await admin("setLiquidatorShareBps(uint16)", "to-5000", (d) =>
    d.contracts.perps.write.setLiquidatorShareBps([5000], owner(d)),
  );
  await admin("setMakerFeeBps(int16)", "zero-to-5", (d) => d.contracts.perps.write.setMakerFeeBps([5], owner(d)));
  await admin("setTakerFeeBps(int16)", "5-to-10", (d) => d.contracts.perps.write.setTakerFeeBps([10], owner(d)));
  await admin("setMinimumMarginPerOrder(uint256)", "to-1-usdc", (d) =>
    d.contracts.perps.write.setMinimumMarginPerOrder([parseUnits("1", 6)], owner(d)),
  );
  await admin("setPortfolioMargin(address)", "revalidate-current-engine", (d) =>
    d.contracts.perps.write.setPortfolioMargin([d.contracts.pme.address], owner(d)),
  );
  {
    const data = await fresh();
    const feed = await viem.deployContract("PriceOracleMock", [data.config.oracle.price, data.config.oracle.decimals]);
    await recordTransaction(
      data.accounts.pc,
      "setOracle(address)",
      "replace-live-feed",
      data.contracts.perps.write.setOracle([feed.address], owner(data)),
    );
  }
  {
    const data = await fresh();
    await fund(data, [data.accounts.seller, data.accounts.buyer]);
    await openPosition(data, units(data, "1"));
    await recordTransaction(
      data.accounts.pc,
      "withdrawCollectedFees()",
      "nonzero fee balance",
      data.contracts.perps.write.withdrawCollectedFees(owner(data)),
    );
  }
  {
    const data = await fresh();
    const { perps } = data.contracts;
    await fund(data, [data.accounts.seller, data.accounts.buyer]);
    const mark = await openPosition(data, units(data, "1"));
    const tick = data.config.minimumPriceIncrement;
    await perps.write.createOrder([mark - tick, units(data, "1"), TimeInForce.GTC], {
      account: data.accounts.buyer.account,
    });
    await perps.write.createOrder([mark + tick, -units(data, "1"), TimeInForce.GTC], {
      account: data.accounts.seller.account,
    });
    const users = [data.accounts.seller.account.address, data.accounts.buyer.account.address];
    await recordTransaction(
      data.accounts.pc,
      "forceCancelOrders(address[])",
      "two users with one order each",
      perps.write.forceCancelOrders([users], owner(data)),
    );
  }
  {
    const data = await fresh();
    const implementation = await viem.deployContract("HashPowerPerpsDEX", [data.contracts.vault.address]);
    await recordTransaction(
      data.accounts.pc,
      "upgradeToAndCall(address,bytes)",
      "new compatible implementation",
      data.contracts.perps.write.upgradeToAndCall([implementation.address, "0x"], owner(data)),
    );
  }
  await admin("transferOwnership(address)", "to-seller", (d) =>
    d.contracts.perps.write.transferOwnership([d.accounts.seller.account.address], owner(d)),
  );
  await admin("renounceOwnership()", "current owner", (d) => d.contracts.perps.write.renounceOwnership(owner(d)));
}

describe("Perps gas benchmark", () => {
  it("records deterministic receipt gas, view estimates, and complete ABI coverage", async () => {
    await benchmarkViews();
    await benchmarkScaledRiskViews();
    await benchmarkOrderPlacement();
    await benchmarkOrderMaintenance();
    await benchmarkLiquidations();
    await benchmarkFunding();
    await benchmarkAdminAndLifecycle();

    const snapshot = gas.snapshot();
    const coverage = assertAbiFunctionCoverage(HashPowerPerpsDEXAbi, snapshot, exclusions);
    assert.equal(coverage.covered.length, 63);
    assert.deepEqual(coverage.excluded, ["initialize(address,address)", "proxiableUUID()"]);

    await mkdir(fileURLToPath(new URL("../../benchmarks", import.meta.url)), { recursive: true });
    await writeSnapshot(SNAPSHOT_PATH, snapshot);
  });
});
