import { describe, it } from "node:test";
import { network } from "hardhat";
import { maxUint256 } from "viem";
import { deployPerpsWithCollateralFixture } from "./fixtures.ts";
import { TimeInForce } from "../fixtures/timeInForce.ts";

const { viem, networkHelpers } = await network.connect();

/**
 * X3-D-1: a resting order whose quantity lifts to ~2^256 in the engine's WAD math wraps
 * the engine's signed order delta, reading IM ≈ 0 for an arbitrarily large book. The
 * venue must refuse such a quantity outright.
 */
describe("X3-D-1 — perps rejects quantities that overflow portfolio margin math", () => {
  // Raw quantity (QUANTITY_DECIMALS = 6) whose 1e12 WAD lift sits just under 2^256.
  const POISON_QTY = maxUint256 / 10n ** 12n;

  it("rejects a poison bid", async () => {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;

    await viem.assertions.revertWithCustomError(
      perps.write.createOrder([config.minimumPriceIncrement, POISON_QTY, TimeInForce.GTC], {
        account: accounts.buyer.account,
      }),
      perps,
      "InvalidQty",
    );
  });

  it("rejects a poison ask", async () => {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);
    const { perps } = contracts;
    const price = (await perps.read.getMarketPrice()) + config.minimumPriceIncrement;

    await viem.assertions.revertWithCustomError(
      perps.write.createOrder([price, -POISON_QTY, TimeInForce.GTC], { account: accounts.seller.account }),
      perps,
      "InvalidQty",
    );
  });
});
