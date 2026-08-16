/**
 * Integration test: a perps *order* liquidation must surface on the Order
 * entity as `status = LIQUIDATED` (with `liquidator` + `liquidationFee`
 * attribution), mirroring the futures Order API.
 *
 * `liquidateOrder(user, orderId)` emits BOTH `OrderCancelled` AND
 * `OrderLiquidated` in the same tx (OrderCancelled first — see
 * `HashPowerPerpsDEX._doLiquidateOrder`). The indexer must end at
 * `LIQUIDATED`: the co-emitted `OrderCancelled` must NOT clobber it.
 *
 * Drives the real `HashPowerPerpsDEX`:
 *   - an underwater seller with one resting short order,
 *   - `makeUnderwater()` doubles the oracle price,
 *   - `liquidateOrder(seller, restingId)` force-cancels that order.
 *
 * The harness replays the resting order's `OrderCreated` + the
 * `OrderCancelled`/`OrderLiquidated` pair through `src/perps.ts` (no anchor),
 * and we assert the final Order state.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseEventLogs, parseUnits } from "viem";
import { deployPerpsFixture } from "../../contracts/tests/fixtures.ts";
import { TimeInForce } from "../../contracts/fixtures/timeInForce.ts";

const conn = await network.getOrCreate();
const { matchstick } = conn;

/**
 * Underwater seller that ALSO has a resting short order, so we can liquidate
 * the order leg. Mirrors `deployUnderwaterWithOrdersFixture` from the contracts
 * suite, trimmed to a single resting order.
 */
async function deployPerpsUnderwaterWithRestingOrderFixture(
  c: Parameters<typeof deployPerpsFixture>[0],
) {
  const data = await deployPerpsFixture(c);
  const { contracts, accounts, config, utils } = data;
  const { perps, priceOracle, vault } = contracts;
  const { seller, buyer, owner } = accounts;

  // Fee small enough that the seller's vault fully covers it on cancel.
  const liquidationFeeBps = 50;
  await perps.write.setLiquidationFeeBps([liquidationFeeBps], { account: owner.account });

  const initialPrice = await perps.read.getMarketPrice();
  const tick = config.minimumPriceIncrement;
  const qty = parseUnits("1", config.quantityDecimals);
  const minCollateral = utils.getMinimumCollateral(initialPrice, qty);

  await vault.write.deposit([minCollateral], { account: seller.account });
  await vault.write.deposit([minCollateral * 2n], { account: buyer.account });

  // Matched position: seller short / buyer long at initialPrice.
  await perps.write.createOrder([initialPrice, -qty, TimeInForce.GTC], { account: seller.account });
  await perps.write.createOrder([initialPrice, qty, TimeInForce.GTC], { account: buyer.account });

  // One resting short for the seller, above the matched price so it doesn't cross.
  const restingQty = parseUnits("0.1", config.quantityDecimals);
  await perps.write.createOrder([initialPrice + 5n * tick, -restingQty, TimeInForce.GTC], {
    account: seller.account,
  });

  return {
    ...data,
    config: { ...config, initialPrice, qty, restingQty, minCollateral, liquidationFeeBps },
    async makeUnderwater() {
      const newPrice = initialPrice * 2n;
      await priceOracle.write.setPrice([newPrice, config.oracle.decimals]);
      return newPrice;
    },
  };
}

describe("liquidateOrder: Order.status = LIQUIDATED wins over co-emitted OrderCancelled", () => {
  after(() => matchstick.reset());

  it("force-cancels the resting order and ends at LIQUIDATED with liquidator + fee", async () => {
    const fixture = await conn.networkHelpers.loadFixture(
      deployPerpsUnderwaterWithRestingOrderFixture,
    );
    const { contracts, accounts } = fixture;
    const { perps } = contracts;
    const { seller, owner, pc } = accounts;

    // The resting short is the seller's only remaining open order (the matched
    // leg filled and was removed).
    const sellerOrders = await perps.read.getUserOrders([seller.account.address]);
    assert.equal(sellerOrders.length, 1, "seller should have exactly one resting order");
    const restingId = sellerOrders[0].toLowerCase() as `0x${string}`;

    // Bind + capture AFTER the fixture created the orders; no anchor() so the
    // resting order's OrderCreated is replayed alongside the liquidation pair.
    matchstick.bind("HashPowerPerpsDEX", perps.address, perps.abi);
    await matchstick.captureViewMocks();

    await fixture.makeUnderwater();

    // Permissionless order liquidation; `owner` is the keeper (msg.sender).
    const liqTx = await perps.write.liquidateOrder([seller.account.address, restingId], {
      account: owner.account,
    });
    const liqReceipt = await pc.waitForTransactionReceipt({ hash: liqTx });

    // Both events fire in one tx, OrderCancelled before OrderLiquidated.
    const events = parseEventLogs({ logs: liqReceipt.logs, abi: perps.abi });
    const cancelled = events.find((e) => e.eventName === "OrderCancelled");
    const liquidated = events.find((e) => e.eventName === "OrderLiquidated");
    assert.ok(cancelled, "liquidateOrder must emit OrderCancelled (indexer compatibility)");
    assert.ok(liquidated, "liquidateOrder must emit OrderLiquidated");
    const cancelledIdx = events.indexOf(cancelled);
    const liquidatedIdx = events.indexOf(liquidated);
    assert.ok(
      cancelledIdx < liquidatedIdx,
      "OrderCancelled is emitted before OrderLiquidated (LIQUIDATED must still win)",
    );

    // biome-ignore lint/suspicious/noExplicitAny: event arg typing from viem decode
    const liqArgs = liquidated.args as any;
    const fee = liqArgs.fee as bigint;
    const ownerAddr = owner.account.address.toLowerCase() as `0x${string}`;

    const snap = await matchstick.indexSnapshot([]);

    const order = snap.entity("Order", restingId) ?? undefined;
    assert.ok(order, "the resting Order entity must exist after replay");

    assert.equal(
      order.status,
      "LIQUIDATED",
      "Order.status must be LIQUIDATED (OrderLiquidated wins over the co-emitted OrderCancelled)",
    );
    assert.equal(
      String(order.liquidator).toLowerCase(),
      ownerAddr,
      "Order.liquidator must be the keeper from OrderLiquidated",
    );
    assert.equal(
      String(order.liquidationFee),
      fee.toString(),
      "Order.liquidationFee must mirror the on-chain OrderLiquidated.fee",
    );
  });
});
