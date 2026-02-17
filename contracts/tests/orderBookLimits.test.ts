import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { parseUnits } from "viem";
import { deployPerpsWithCollateralFixture } from "./fixtures";
import { catchError } from "../lib/lib";

describe("PerpsSimple - Order Book Limits", function () {
  // ─────────────────────────────────────────────────
  // minimumMarginPerOrder
  // ─────────────────────────────────────────────────
  describe("minimumMarginPerOrder", function () {
    it("should allow owner to set minimumMarginPerOrder", async function () {
      const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { owner } = accounts;

      const minMargin = parseUnits("0.5", config.tokenDecimals); // 0.5 USDC
      await perps.write.setMinimumMarginPerOrder([minMargin], { account: owner.account });
      expect(await perps.read.minimumMarginPerOrder()).to.equal(minMargin);
    });

    it("should revert when non-owner tries to set", async function () {
      const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      await catchError(perps.abi, "OwnableUnauthorizedAccount", async () => {
        await perps.write.setMinimumMarginPerOrder([parseUnits("0.5", config.tokenDecimals)], {
          account: buyer.account,
        });
      });
    });

    it("should reject resting order whose margin is below minimumMarginPerOrder", async function () {
      const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer, owner } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const price = marketPrice - config.minimumPriceIncrement;

      // Set minimum margin per order to 0.5 USDC
      // With 10% margin: 1 unit @ ~3 USDC → notional ~3 USDC → margin ~0.3 USDC < 0.5 USDC
      const minMargin = parseUnits("0.5", config.tokenDecimals);
      await perps.write.setMinimumMarginPerOrder([minMargin], { account: owner.account });

      const tinyQty = parseUnits("1", config.quantityDecimals);

      await catchError(perps.abi, "OrderMarginTooLow", async () => {
        await perps.write.createOrder([price, tinyQty], { account: buyer.account });
      });
    });

    it("should accept resting order whose margin is at or above minimumMarginPerOrder", async function () {
      const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer, owner } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const price = marketPrice - config.minimumPriceIncrement;

      // Set minimum margin per order to 0.5 USDC
      // With 10% margin: 2 units @ ~3 USDC → notional ~6 USDC → margin ~0.6 USDC > 0.5 USDC
      const minMargin = parseUnits("0.5", config.tokenDecimals);
      await perps.write.setMinimumMarginPerOrder([minMargin], { account: owner.account });

      const qty = parseUnits("2", config.quantityDecimals);
      await perps.write.createOrder([price, qty], { account: buyer.account });

      const orders = await perps.read.getUserOrders([buyer.account.address]);
      expect(orders.length).to.equal(1);
    });

    it("should not enforce minimum on matched portion, only on resting remainder", async function () {
      const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer, seller, owner } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const qty1 = parseUnits("1", config.quantityDecimals);

      // Seller places a sell order BEFORE minimum is set (margin ~0.3 USDC)
      await perps.write.createOrder([marketPrice, -qty1], { account: seller.account });

      // Now set minimum margin per order to 0.5 USDC
      const minMargin = parseUnits("0.5", config.tokenDecimals);
      await perps.write.setMinimumMarginPerOrder([minMargin], { account: owner.account });

      // Buyer places a buy order for 1 unit at market price
      // This matches immediately (no resting), so minimum doesn't apply
      await perps.write.createOrder([marketPrice, qty1], { account: buyer.account });

      // Both should have positions (buyer's order was fully matched, never rested)
      const posBuyer = await perps.read.getUserPosition([buyer.account.address]);
      expect(posBuyer.netQuantity).to.equal(qty1);
    });

    it("should reject when partially matched remainder margin is below minimum", async function () {
      const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer, seller, owner } = accounts;

      const marketPrice = await perps.read.getMarketPrice();

      // Set minimum margin per order to 0.5 USDC
      // With 10% margin: 1 unit @ ~3 USDC → margin ~0.3 USDC < 0.5 USDC
      const minMargin = parseUnits("0.5", config.tokenDecimals);
      await perps.write.setMinimumMarginPerOrder([minMargin], { account: owner.account });

      // Seller places a sell for 2 units at market price
      const qty2 = parseUnits("2", config.quantityDecimals);
      await perps.write.createOrder([marketPrice, -qty2], { account: seller.account });

      // Buyer places a buy for 3 units at market price
      // 2 units match with seller, 1 unit would rest
      // Resting margin = 1 * ~3 USDC * 10% = ~0.3 USDC < 0.5 USDC minimum → revert
      const qty3 = parseUnits("3", config.quantityDecimals);

      await catchError(perps.abi, "OrderMarginTooLow", async () => {
        await perps.write.createOrder([marketPrice, qty3], { account: buyer.account });
      });
    });

    it("should not enforce minimum when minimumMarginPerOrder is 0 (disabled)", async function () {
      const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const price = marketPrice - config.minimumPriceIncrement;

      // minimumMarginPerOrder defaults to 0 (no minimum)
      expect(await perps.read.minimumMarginPerOrder()).to.equal(0n);

      // Tiny order should be accepted
      const tinyQty = parseUnits("0.001", config.quantityDecimals);
      await perps.write.createOrder([price, tinyQty], { account: buyer.account });

      const orders = await perps.read.getUserOrders([buyer.account.address]);
      expect(orders.length).to.equal(1);
    });

    it("should allow setting minimumMarginPerOrder to 0 to disable", async function () {
      const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { owner } = accounts;

      await perps.write.setMinimumMarginPerOrder([parseUnits("0.5", config.tokenDecimals)], {
        account: owner.account,
      });
      expect(await perps.read.minimumMarginPerOrder()).to.not.equal(0n);

      await perps.write.setMinimumMarginPerOrder([0n], { account: owner.account });
      expect(await perps.read.minimumMarginPerOrder()).to.equal(0n);
    });

    it("high-leverage order should require same margin as low-leverage order of same size", async function () {
      const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer, owner } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const price = marketPrice - config.minimumPriceIncrement;

      // Set minimum margin high enough to reject 1-unit orders
      // margin = notional * marginPercent / 100
      // Since marginPercent is a global setting, leverage is the same for everyone.
      // With 10% margin: 1 unit @ ~3 USDC → margin ~0.3 USDC
      // A spammer cannot bypass this by using "high leverage" because
      // marginPercent is fixed per-contract, not per-order.
      const minMargin = parseUnits("0.5", config.tokenDecimals);
      await perps.write.setMinimumMarginPerOrder([minMargin], { account: owner.account });

      // 1-unit order should still fail regardless of how much collateral the user has
      const tinyQty = parseUnits("1", config.quantityDecimals);
      await catchError(perps.abi, "OrderMarginTooLow", async () => {
        await perps.write.createOrder([price, tinyQty], { account: buyer.account });
      });
    });
  });

  // ─────────────────────────────────────────────────
  // MAX_PRICE_LEVELS_PER_SIDE (constant = 200)
  // ─────────────────────────────────────────────────
  describe("MAX_PRICE_LEVELS_PER_SIDE", function () {
    it("should be set to 200", async function () {
      const { contracts } = await loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;

      expect(await perps.read.MAX_PRICE_LEVELS_PER_SIDE()).to.equal(200n);
    });

    it("should allow orders at existing price levels even when cap is reached", async function () {
      const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer, buyer2, seller } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const tick = config.minimumPriceIncrement;
      const qty = parseUnits("0.01", config.quantityDecimals);

      // Fill all 200 bid price levels across 2 users (100 each, per-user cap)
      for (let i = 1; i <= 100; i++) {
        await perps.write.createOrder([marketPrice - BigInt(i) * tick, qty], {
          account: buyer.account,
        });
      }
      for (let i = 101; i <= 200; i++) {
        await perps.write.createOrder([marketPrice - BigInt(i) * tick, qty], {
          account: buyer2.account,
        });
      }

      // 201st price level should fail (use seller who has 0 orders)
      await catchError(perps.abi, "MaxPriceLevelsReached", async () => {
        await perps.write.createOrder([marketPrice - 201n * tick, qty], { account: seller.account });
      });

      // But an order at an EXISTING price level should succeed
      await perps.write.createOrder([marketPrice - tick, qty], { account: seller.account });
    });

    it("should allow new price level after cancellation frees a slot", async function () {
      const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer, buyer2, seller } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const tick = config.minimumPriceIncrement;
      const qty = parseUnits("0.01", config.quantityDecimals);

      // Fill all 200 bid price levels across 2 users
      for (let i = 1; i <= 100; i++) {
        await perps.write.createOrder([marketPrice - BigInt(i) * tick, qty], {
          account: buyer.account,
        });
      }
      for (let i = 101; i <= 200; i++) {
        await perps.write.createOrder([marketPrice - BigInt(i) * tick, qty], {
          account: buyer2.account,
        });
      }

      // Cancel one order (frees a price level)
      const orders = await perps.read.getUserOrders([buyer.account.address]);
      await perps.write.cancelOrder([orders[0]], { account: buyer.account });

      // Now a new price level should be allowed (seller has 0 orders)
      await perps.write.createOrder([marketPrice - 201n * tick, qty], { account: seller.account });
    });

    it("should enforce cap independently per side (bids vs asks)", async function () {
      const { contracts, accounts, config } = await loadFixture(deployPerpsWithCollateralFixture);
      const { perps } = contracts;
      const { buyer, seller } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const tick = config.minimumPriceIncrement;
      const qty = parseUnits("0.01", config.quantityDecimals);

      // Place 20 bid levels and 20 ask levels — both should succeed
      // (well under 200 per side)
      for (let i = 1; i <= 20; i++) {
        await perps.write.createOrder([marketPrice - BigInt(i) * tick, qty], {
          account: buyer.account,
        });
        await perps.write.createOrder([marketPrice + BigInt(i) * tick, -qty], {
          account: seller.account,
        });
      }

      const ordersBuyer = await perps.read.getUserOrders([buyer.account.address]);
      const ordersSeller = await perps.read.getUserOrders([seller.account.address]);
      expect(ordersBuyer.length).to.equal(20);
      expect(ordersSeller.length).to.equal(20);
    });
  });
});
