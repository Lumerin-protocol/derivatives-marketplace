import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseEventLogs } from "viem";
import { TimeInForce } from "../fixtures/timeInForce.ts";
import {
  deployPerpsWithCollateralFixture,
  deployPerpsWithPositionsFixture,
} from "./fixtures.ts";

const { viem, networkHelpers } = await network.connect();

describe("HashPowerPerpsDEX.resetParticipantState", function () {
  it("clears only explicitly supplied participants", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithPositionsFixture,
    );
    const { perps } = contracts;
    const { owner, seller, buyer } = accounts;
    const sellerPosition = await perps.read.getUserPosition([seller.account.address]);
    const buyerPosition = await perps.read.getUserPosition([buyer.account.address]);
    const tick = config.minimumPriceIncrement;

    await perps.write.createOrder(
      [config.marketPrice + tick, -config.qty, TimeInForce.GTC],
      { account: seller.account },
    );
    await perps.write.createOrder(
      [config.marketPrice - tick, config.qty, TimeInForce.GTC],
      { account: buyer.account },
    );
    const sellerOrderIds = await perps.read.getUserOrders([seller.account.address]);
    const buyerOrderIds = await perps.read.getUserOrders([buyer.account.address]);

    await perps.write.resetParticipantState([[seller.account.address]], {
      account: owner.account,
    });

    assert.deepEqual(await perps.read.getUserOrders([seller.account.address]), []);
    assert.deepEqual(await perps.read.getUserPosition([seller.account.address]), {
      netQuantity: 0n,
      netEntryValue: 0n,
    });
    assert.equal(await perps.read.getPendingFunding([seller.account.address]), 0n);
    assert.deepEqual(await perps.read.getUserOrders([buyer.account.address]), buyerOrderIds);
    assert.deepEqual(await perps.read.getUserPosition([buyer.account.address]), buyerPosition);

    for (const orderId of sellerOrderIds) {
      assert.equal((await perps.read.getOrder([orderId])).participant, "0x0000000000000000000000000000000000000000");
    }
    assert.notDeepEqual(sellerPosition, await perps.read.getUserPosition([seller.account.address]));
  });

  it("is idempotent, preserves nonce monotonicity, and emits no legacy fee event", async function () {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { owner, buyer } = accounts;
    const price = (await perps.read.getMarketPrice()) - config.minimumPriceIncrement;

    await perps.write.createOrder([price, 1n, TimeInForce.GTC], {
      account: buyer.account,
    });
    const [oldOrderId] = await perps.read.getUserOrders([buyer.account.address]);

    const hash = await perps.write.resetParticipantState(
      [[buyer.account.address, buyer.account.address]],
      { account: owner.account },
    );
    const receipt = await (await viem.getPublicClient()).waitForTransactionReceipt({ hash });
    const events = parseEventLogs({ abi: perps.abi, logs: receipt.logs });
    assert.equal(events.some((event) => event.eventName === "MatchFeeUpdated"), false);

    await perps.write.resetParticipantState([[buyer.account.address]], {
      account: owner.account,
    });
    await perps.write.createOrder([price, 1n, TimeInForce.GTC], {
      account: buyer.account,
    });
    const [newOrderId] = await perps.read.getUserOrders([buyer.account.address]);
    assert.ok(BigInt(newOrderId) > BigInt(oldOrderId));
  });

  it("remains owner-only", async function () {
    const { contracts, accounts } = await networkHelpers.loadFixture(
      deployPerpsWithCollateralFixture,
    );
    const { perps } = contracts;
    const { buyer } = accounts;

    await viem.assertions.revertWithCustomError(
      perps.write.resetParticipantState([[buyer.account.address]], {
        account: buyer.account,
      }),
      perps,
      "OwnableUnauthorizedAccount",
    );
  });
});
