import { describe, it } from "node:test";
import { network } from "hardhat";
import { TimeInForce } from "../fixtures/timeInForce.ts";
import { deployPerpsWithCollateralFixture } from "./fixtures.ts";

const { viem, networkHelpers } = await network.connect();

/**
 * `MAX_ORDER_QUANTITY` is the bound X3-D-1 and the CF-007 overflow argument rest on. An order
 * at the cap clears quantity validation (an unfunded one then fails the margin check); one
 * contract unit above it is rejected outright.
 */
describe("HashPowerPerpsDEX order quantity cap", function () {
  for (const side of [1n, -1n]) {
    const label = side > 0n ? "a bid" : "an ask";

    it(`accepts ${label} at MAX_ORDER_QUANTITY and rejects one above it`, async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const account = accounts.buyer.account;
      const price = await perps.read.getMarketPrice();
      const cap = await perps.read.MAX_ORDER_QUANTITY();

      await viem.assertions.revertWithCustomError(
        perps.write.createOrder([price, side * cap, TimeInForce.GTC], { account }),
        perps,
        "InsufficientMarginBalance",
      );
      await viem.assertions.revertWithCustomError(
        perps.write.createOrder([price, side * (cap + 1n), TimeInForce.GTC], { account }),
        perps,
        "InvalidQty",
      );
    });
  }
});
