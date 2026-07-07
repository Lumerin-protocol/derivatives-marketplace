import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { parseUnits, getAddress, parseEventLogs, zeroAddress, maxUint256 } from "viem";
import {
  deployPerpsWithCollateralFixture,
  deployPerpsWithLiquidatablePositionFixture,
} from "./fixtures.ts";

const { viem, networkHelpers } = await network.connect();

const WAD = 10n ** 18n; // PointsHook.WEIGHT_SCALE — weight 1 WAD == 1 point per notional unit.
const KEEPER_POINTS = parseUnits("10", 6); // flat keeper reward (POINTS has 6 decimals).

/**
 * Deploy the real `Points` ledger + `PointsHook` from collateral-margin and wire the roles:
 *   - the hook gets `MINTER_ROLE` on `Points`,
 *   - the perps venue gets `HOOK_CALLER_ROLE` on the hook (unless `grantCaller` is false,
 *     which exercises the "venue not authorized → fill/liquidation reverts" path).
 * Maker and taker weights are 1 WAD so minted points equal the trade notional.
 */
async function deployPointsStack(
  perpsAddress: `0x${string}`,
  owner: { account: { address: `0x${string}` } },
  grantCaller = true,
) {
  const admin = owner.account.address;
  const points = await viem.deployContract("Points", [admin]);
  const hook = await viem.deployContract("PointsHook", [points.address, admin, WAD, WAD, KEEPER_POINTS]);

  const minterRole = await points.read.MINTER_ROLE();
  await points.write.grantRole([minterRole, hook.address], { account: owner.account });

  if (grantCaller) {
    const callerRole = await hook.read.HOOK_CALLER_ROLE();
    await hook.write.grantRole([callerRole, perpsAddress], { account: owner.account });
  }

  return { points, hook };
}

describe("HashPowerPerpsDEX - points hook wiring", function () {
  describe("setHook", function () {
    it("allows the owner to set the hook and emits HookUpdated", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(
        deployPerpsWithCollateralFixture,
      );
      const { perps } = contracts;
      const { owner, buyer, pc } = accounts;

      const txHash = await perps.write.setHook([buyer.account.address], { account: owner.account });
      const receipt = await pc.waitForTransactionReceipt({ hash: txHash });
      const [{ args }] = parseEventLogs({ logs: receipt.logs, abi: perps.abi, eventName: "HookUpdated" });

      assert.equal(args.hook, getAddress(buyer.account.address));
      assert.equal(await perps.read.hook(), getAddress(buyer.account.address));
    });

    it("allows the owner to clear the hook with the zero address", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(
        deployPerpsWithCollateralFixture,
      );
      const { perps } = contracts;
      const { owner, buyer } = accounts;

      await perps.write.setHook([buyer.account.address], { account: owner.account });
      await perps.write.setHook([zeroAddress], { account: owner.account });
      assert.equal(await perps.read.hook(), zeroAddress);
    });

    it("reverts when a non-owner sets the hook", async function () {
      const { contracts, accounts } = await networkHelpers.loadFixture(
        deployPerpsWithCollateralFixture,
      );
      const { perps } = contracts;
      const { buyer } = accounts;

      await viem.assertions.revertWithCustomError(
        perps.write.setHook([buyer.account.address], { account: buyer.account }),
        perps,
        "OwnableUnauthorizedAccount",
      );
    });
  });

  describe("onFill", function () {
    it("mints points to the taker on a match (maker earns nothing when makerFee is 0)", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(
        deployPerpsWithCollateralFixture,
      );
      const { perps } = contracts;
      const { owner, seller, buyer } = accounts;

      const { points, hook } = await deployPointsStack(perps.address, owner);
      await perps.write.setHook([hook.address], { account: owner.account });

      const marketPrice = await perps.read.getMarketPrice();
      const qty = parseUnits("1", config.quantityDecimals);

      await perps.write.createOrder([marketPrice, -qty], { account: seller.account });
      await perps.write.createOrder([marketPrice, qty], { account: buyer.account });

      const notional = (marketPrice * qty) / 10n ** BigInt(config.quantityDecimals);

      // wTaker == 1 WAD, so taker points == notional. makerFeeBps is 0, so the maker earns nothing.
      assert.equal(await points.read.balanceOf([buyer.account.address]), notional, "taker earns notional");
      assert.equal(await points.read.balanceOf([seller.account.address]), 0n, "maker earns nothing");
    });

    it("does not mint (or revert) when no hook is configured", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(
        deployPerpsWithCollateralFixture,
      );
      const { perps } = contracts;
      const { seller, buyer } = accounts;

      const marketPrice = await perps.read.getMarketPrice();
      const qty = parseUnits("1", config.quantityDecimals);

      await perps.write.createOrder([marketPrice, -qty], { account: seller.account });
      await perps.write.createOrder([marketPrice, qty], { account: buyer.account });
      assert.equal(await perps.read.hook(), zeroAddress);
    });

    it("reverts the fill when the venue lacks HOOK_CALLER_ROLE (no try/catch isolation)", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(
        deployPerpsWithCollateralFixture,
      );
      const { perps } = contracts;
      const { owner, seller, buyer } = accounts;

      // Hook is plugged in but the venue was never granted HOOK_CALLER_ROLE.
      const { hook } = await deployPointsStack(perps.address, owner, false);
      await perps.write.setHook([hook.address], { account: owner.account });

      const marketPrice = await perps.read.getMarketPrice();
      const qty = parseUnits("1", config.quantityDecimals);

      await perps.write.createOrder([marketPrice, -qty], { account: seller.account });
      await assert.rejects(
        perps.write.createOrder([marketPrice, qty], { account: buyer.account }),
      );
    });
  });

  describe("maker price-improvement multiplier", function () {
    it("boosts maker points when the resting quote sits at the oracle price", async function () {
      const { contracts, accounts, config } = await networkHelpers.loadFixture(
        deployPerpsWithCollateralFixture,
      );
      const { perps } = contracts;
      const { owner, seller, buyer } = accounts;

      const { points, hook } = await deployPointsStack(perps.address, owner);
      await perps.write.setHook([hook.address], { account: owner.account });

      // Maker must pay a positive fee to earn; enable a 3x bonus tapering over a 1% spread.
      await perps.write.setMatchFee([10, 5], { account: owner.account });
      await hook.write.setPriceImprovement([3n * WAD, WAD / 100n], { account: owner.account });

      const marketPrice = await perps.read.getMarketPrice();
      const qty = parseUnits("1", config.quantityDecimals);

      // Seller rests at the oracle price (spread 0 → full 3x), buyer takes.
      await perps.write.createOrder([marketPrice, -qty], { account: seller.account });
      await perps.write.createOrder([marketPrice, qty], { account: buyer.account });

      const notional = (marketPrice * qty) / 10n ** BigInt(config.quantityDecimals);

      // wMaker == 1 WAD and the maker quoted at the reference price → 3x notional.
      assert.equal(
        await points.read.balanceOf([seller.account.address]),
        notional * 3n,
        "maker earns 3x at zero spread",
      );
      // The taker is unaffected by the maker multiplier.
      assert.equal(await points.read.balanceOf([buyer.account.address]), notional, "taker earns notional");
    });
  });

  describe("onLiquidation", function () {
    it("mints flat keeper points to the liquidator on a position liquidation", async function () {
      const data = await networkHelpers.loadFixture(deployPerpsWithLiquidatablePositionFixture);
      const { contracts, accounts } = data;
      const { perps } = contracts;
      const { owner, seller, buyer2 } = accounts;

      const { points, hook } = await deployPointsStack(perps.address, owner);
      await perps.write.setHook([hook.address], { account: owner.account });

      await data.makeLiquidatable();
      await perps.write.liquidatePosition([seller.account.address, maxUint256], { account: buyer2.account });

      assert.equal(await points.read.balanceOf([buyer2.account.address]), KEEPER_POINTS);
    });

    it("reverts the liquidation when the venue lacks HOOK_CALLER_ROLE", async function () {
      const data = await networkHelpers.loadFixture(deployPerpsWithLiquidatablePositionFixture);
      const { contracts, accounts } = data;
      const { perps } = contracts;
      const { owner, seller, buyer2 } = accounts;

      const { hook } = await deployPointsStack(perps.address, owner, false);
      await perps.write.setHook([hook.address], { account: owner.account });

      await data.makeLiquidatable();
      await assert.rejects(
        perps.write.liquidatePosition([seller.account.address, maxUint256], { account: buyer2.account }),
      );

      const positionAfter = await perps.read.getUserPosition([seller.account.address]);
      assert.notEqual(positionAfter.netQuantity, 0n, "liquidation reverted, position still open");
    });
  });
});
