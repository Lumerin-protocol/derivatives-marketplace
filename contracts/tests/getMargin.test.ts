import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import {
  deployPerpsFixture,
  deployPerpsWithCollateralFixture,
  deployPerpsWithOrdersFixture,
  deployPerpsWithPositionsFixture,
  deployPerpsWithLiquidatablePositionFixture,
} from "./fixtures.ts";
import { parseUnits } from "viem";
import { TimeInForce } from "../fixtures/timeInForce.ts";

const { networkHelpers:{ loadFixture } } = await network.getOrCreate();

describe("HashPowerPerpsDEX - Margin View Functions", function () {
  describe("portfolio maintenance margin", function () {
    it("should return 0 when user has no orders or positions", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsWithCollateralFixture);
      const { pme } = contracts;
      const { buyer } = accounts;

      const margin = await pme.read.computePortfolioMM([buyer.account.address]);
      assert.equal(margin, 0n);
    });

    it("should include margin for open orders", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsWithOrdersFixture);
      const { perps, pme } = contracts;
      const { buyer } = accounts;

      const risk = await perps.read.getRiskView([buyer.account.address]);
      assert.ok(risk.buyOrderDelta > 0n || risk.sellOrderDelta > 0n);

      // Orders alone are enough to break MM — the point of stressing order delta.
      assert.ok((await pme.read.computePortfolioMM([buyer.account.address])) > 0n);
      assert.ok((await pme.read.orderMarginOf([buyer.account.address])) > 0n);
    });

    it("the reservation on resting orders bounds the IM after any subset of them fills", async function () {
      // The guarantee the whole two-leg construction exists to provide. There is no
      // margin check on a maker at fill time, so whatever is reserved against a
      // resting order is the only thing standing between a fill and an
      // under-collateralized account. Both legs must therefore bound the requirement
      // after *any* subset of the account's orders fills.
      //
      // The fixture leaves the buyer three resting bids below the mark and the seller
      // three resting asks above it. We walk every subset size on both sides and check
      // the pre-fill IM still covers the post-fill IM.
      for (const filled of [1n, 2n, 3n]) {
        const { contracts, accounts, config } = await loadFixture(
          deployPerpsWithOrdersFixture,
        );
        const { perps, pme } = contracts;
        const { buyer, seller, buyer2 } = accounts;
        const tick = config.minimumPriceIncrement;

        const buyerImBefore = await pme.read.computePortfolioIM([buyer.account.address]);
        const sellerImBefore = await pme.read.computePortfolioIM([seller.account.address]);

        // A taker sell priced down to the `filled`-th bid crosses exactly that many,
        // best bid first; the mirrored taker buy crosses that many asks.
        await perps.write.createOrder(
          [config.marketPrice - filled * tick, -(filled * config.qty), TimeInForce.GTC],
          { account: buyer2.account },
        );
        await perps.write.createOrder([config.marketPrice + filled * tick, filled * config.qty, TimeInForce.GTC], {
          account: buyer2.account,
        });

        const buyerImAfter = await pme.read.computePortfolioIM([buyer.account.address]);
        const sellerImAfter = await pme.read.computePortfolioIM([seller.account.address]);

        assert.ok(
          buyerImAfter <= buyerImBefore,
          `buyer: ${filled} bid(s) filled pushed IM from ${buyerImBefore} to ${buyerImAfter}`,
        );
        assert.ok(
          sellerImAfter <= sellerImBefore,
          `seller: ${filled} ask(s) filled pushed IM from ${sellerImBefore} to ${sellerImAfter}`,
        );

        // The bound is tight, not merely safe: a filled bid moves its delta from
        // `buyOrderDelta` into `netPositionDelta`, which leaves the `netDelta + buy`
        // leg at exactly the same place. Charging any less would leave a gap.
        assert.equal(buyerImAfter, buyerImBefore);
        assert.equal(sellerImAfter, sellerImBefore);

        // Sanity: the fills really happened.
        const risk = await perps.read.getRiskView([buyer.account.address]);
        assert.equal(risk.buyOrderDelta, (3n - filled) * 10n ** 6n);
      }
    });

    it("reserves a bid's instant fill loss and hands it over as unrealized loss", async function () {
      // A bid above the mark fills at a loss the instant it trades. `getRiskView`
      // reports that as `buyOrderFillLoss`, the engine charges it in both stress legs,
      // and after the fill the very same number reappears as the position's unrealized
      // loss — so the requirement does not jump.
      const { contracts, accounts, config } = await loadFixture(
        deployPerpsWithCollateralFixture,
      );
      const { perps, pme } = contracts;
      const { buyer, buyer2 } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const tick = config.minimumPriceIncrement;
      const qty = parseUnits("1", config.quantityDecimals);
      // Book is empty, so a bid five ticks above the mark rests instead of crossing.
      const limit = marketPrice + 5n * tick;

      await perps.write.createOrder([limit, qty, TimeInForce.GTC], { account: buyer.account });

      const risk = await perps.read.getRiskView([buyer.account.address]);
      const expectedLoss = ((limit - marketPrice) * qty) / 10n ** BigInt(config.quantityDecimals);
      assert.equal(risk.buyOrderFillLoss, expectedLoss, "loss is the whole distance to the mark");
      assert.equal(risk.sellOrderFillLoss, 0n);

      const imBefore = await pme.read.computePortfolioIM([buyer.account.address]);

      await perps.write.createOrder([limit, -qty, TimeInForce.GTC], { account: buyer2.account });

      const imAfter = await pme.read.computePortfolioIM([buyer.account.address]);
      const filledRisk = await perps.read.getRiskView([buyer.account.address]);
      assert.equal(filledRisk.buyOrderDelta, 0n, "the bid is gone");
      assert.equal(filledRisk.buyOrderFillLoss, 0n);
      assert.equal(filledRisk.unrealizedPnl, -expectedLoss, "the loss is now on the position");
      assert.equal(imAfter, imBefore, "reserved exactly what the fill went on to cost");
    });

    it("should include margin for open positions", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsWithPositionsFixture);
      const { pme } = contracts;
      const { buyer } = accounts;

      const margin = await pme.read.computePortfolioMM([buyer.account.address]);
      assert.ok(margin > 0n);
    });

    it("should increase when price moves against position", async function () {
      const data = await loadFixture(deployPerpsWithLiquidatablePositionFixture);
      const { contracts, accounts } = data;
      const { perps, pme, priceOracle } = contracts;
      const { seller } = accounts;

      const marginBefore = await pme.read.computePortfolioMM([seller.account.address]);

      const currentPrice = await perps.read.getMarketPrice();
      const newPrice = (currentPrice * 110n) / 100n;
      await priceOracle.write.setPrice([newPrice, 6]);

      const marginAfter = await pme.read.computePortfolioMM([seller.account.address]);
      assert.ok(marginAfter > marginBefore);
    });

    it("should decrease when price moves in favor of position", async function () {
      const data = await loadFixture(deployPerpsWithLiquidatablePositionFixture);
      const { contracts, accounts } = data;
      const { perps, pme, priceOracle } = contracts;
      const { seller } = accounts;

      const marginBefore = await pme.read.computePortfolioMM([seller.account.address]);

      const currentPrice = await perps.read.getMarketPrice();
      const newPrice = (currentPrice * 90n) / 100n;
      await priceOracle.write.setPrice([newPrice, 6]);

      const marginAfter = await pme.read.computePortfolioMM([seller.account.address]);
      assert.ok(marginAfter <= marginBefore);
    });
  });

  describe("isLiquidatable (portfolio margin engine)", function () {
    it("should return false for user with no position", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsWithCollateralFixture);
      const { pme } = contracts;
      const { buyer } = accounts;

      const isLiquidatable = await pme.read.isLiquidatable([buyer.account.address]);
      assert.ok(!isLiquidatable);
    });

    it("should return false for healthy position", async function () {
      const { contracts, accounts } = await loadFixture(deployPerpsWithPositionsFixture);
      const { pme } = contracts;
      const { buyer } = accounts;

      const isLiquidatable = await pme.read.isLiquidatable([buyer.account.address]);
      assert.ok(!isLiquidatable);
    });

    it("should return true for underwater position", async function () {
      const data = await loadFixture(deployPerpsWithLiquidatablePositionFixture);
      const { contracts, accounts } = data;
      const { pme } = contracts;
      const { seller } = accounts;

      let isLiquidatable = await pme.read.isLiquidatable([seller.account.address]);
      assert.ok(!isLiquidatable);

      await data.makeLiquidatable();

      isLiquidatable = await pme.read.isLiquidatable([seller.account.address]);
      assert.ok(isLiquidatable);
    });

    it("returns true for an underwater order-only account", async function () {
      const data = await loadFixture(deployPerpsFixture);
      const { contracts, accounts, config } = data;
      const { perps, pme, priceOracle, vault } = contracts;
      const { buyer } = accounts;
      const mark = await perps.read.getMarketPrice();
      const quantity = parseUnits("1", config.quantityDecimals);
      const bidPrice = mark - config.minimumPriceIncrement;
      const notional = (bidPrice * quantity) / 10n ** BigInt(config.quantityDecimals);
      const initialMargin = await pme.read.linearOrderMargin([notional]);

      // A small buffer covers rounding and the engine's strict balance > IM placement check.
      await vault.write.deposit([initialMargin * 2n], { account: buyer.account });
      await perps.write.createOrder([bidPrice, quantity, TimeInForce.GTC], {
        account: buyer.account,
      });
      assert.equal((await perps.read.getUserPosition([buyer.account.address])).netQuantity, 0n);
      assert.equal(await perps.read.hasRestingOrderDelta([buyer.account.address]), true);
      assert.equal(await pme.read.isLiquidatable([buyer.account.address]), false);

      await priceOracle.write.setPrice([mark / 2n, config.oracle.decimals]);
      assert.ok(
        (await vault.read.balanceOf([buyer.account.address])) <
          (await pme.read.computePortfolioMM([buyer.account.address])),
      );
      assert.equal(await pme.read.isLiquidatable([buyer.account.address]), true);
    });

    it("should correctly identify liquidatable when balance < portfolio maintenance margin", async function () {
      const data = await loadFixture(deployPerpsWithLiquidatablePositionFixture);
      const { contracts, accounts } = data;
      const { perps, pme, vault } = contracts;
      const { seller } = accounts;

      await data.makeLiquidatable();

      const balance = await vault.read.balanceOf([seller.account.address]);
      const maintenanceMargin = await pme.read.computePortfolioMM([seller.account.address]);

      assert.ok(balance < maintenanceMargin);
      assert.ok(await pme.read.isLiquidatable([seller.account.address]));
    });
  });
});
