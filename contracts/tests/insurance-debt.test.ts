import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { maxUint256, parseEventLogs, parseUnits } from "viem";
import {
  deployPerpsFixture,
  deployPerpsWithFundingAndPositionsFixture,
} from "./fixtures.ts";
import { TimeInForce } from "../fixtures/timeInForce.ts";

const { viem, networkHelpers } = await network.connect();

describe("Perps insurance-fund debt", () => {
  it("halts when a winning close crosses the cap and keeps risk-reducing paths open", async () => {
    const data = await networkHelpers.loadFixture(deployPerpsFixture);
    const { contracts, accounts, config } = data;
    const { perps, priceOracle, vault } = contracts;
    const { owner, seller, buyer, buyer2, pc } = accounts;
    const entry = await perps.read.getMarketPrice();
    const quantity = parseUnits("10", config.quantityDecimals);
    const tick = config.minimumPriceIncrement;
    const collateral = entry * 2n;

    await perps.write.setTakerFeeBps([0], { account: owner.account });
    await perps.write.setMakerFeeBps([0], { account: owner.account });
    await vault.write.deposit([collateral], { account: seller.account });
    await vault.write.deposit([collateral], { account: buyer.account });
    await vault.write.deposit([collateral], { account: buyer2.account });

    await perps.write.createOrder([entry, -quantity, TimeInForce.GTC], { account: seller.account });
    await perps.write.createOrder([entry, quantity, TimeInForce.GTC], { account: buyer.account });

    const exit = entry * 3n;
    const reduceHash = await perps.write.createOrder([exit + 10n * tick, -parseUnits("2", config.quantityDecimals), TimeInForce.GTC], {
      account: seller.account,
    });
    const cancelHash = await perps.write.createOrder([exit + 12n * tick, -parseUnits("1", config.quantityDecimals), TimeInForce.GTC], {
      account: seller.account,
    });
    const reduceReceipt = await pc.waitForTransactionReceipt({ hash: reduceHash });
    const cancelReceipt = await pc.waitForTransactionReceipt({ hash: cancelHash });
    const reduceId = parseEventLogs({ logs: reduceReceipt.logs, abi: perps.abi, eventName: "OrderCreated" })[0].args.orderId;
    const cancelId = parseEventLogs({ logs: cancelReceipt.logs, abi: perps.abi, eventName: "OrderCreated" })[0].args.orderId;

    const insurance = await vault.read.insuranceFundBalance();
    await vault.write.withdrawInsuranceFund([owner.account.address, insurance], { account: owner.account });
    await vault.write.setInsuranceDebtCap([1n], { account: owner.account });

    await priceOracle.write.setPrice([exit, config.oracle.decimals]);
    await perps.write.createOrder([exit, quantity, TimeInForce.GTC], { account: seller.account });
    await perps.write.createOrder([exit, -quantity, TimeInForce.GTC], { account: buyer.account });

    assert.ok((await vault.read.insuranceDebt()) > 1n);
    assert.equal(await vault.read.halted(), true);

    const far = exit + 20n * tick;
    await viem.assertions.revertWithCustomError(
      perps.write.createOrder([far, -parseUnits("1", config.quantityDecimals), TimeInForce.GTC], {
        account: seller.account,
      }),
      perps,
      "TradingHalted",
    );
    await viem.assertions.revertWithCustomError(
      perps.write.updateOrders([[], [], [{ price: far, quantity: -parseUnits("1", config.quantityDecimals), timeInForce: TimeInForce.GTC }]], {
        account: seller.account,
      }),
      perps,
      "TradingHalted",
    );
    await viem.assertions.revertWithCustomError(
      vault.write.withdraw([1n], { account: buyer.account }),
      vault,
      "Halted",
    );
    await viem.assertions.revertWithCustomError(
      perps.write.withdrawCollectedFees({ account: owner.account }),
      vault,
      "Halted",
    );

    await perps.write.reduceOrderSize([reduceId, -parseUnits("1", config.quantityDecimals)], {
      account: seller.account,
    });
    await perps.write.updateOrders([[cancelId], [], []], { account: seller.account });
    await perps.write.cancelOrder([reduceId], { account: seller.account });
    await perps.write.updateFunding();
    await vault.write.depositFor([seller.account.address, 1n], { account: owner.account });
    await perps.write.setMakerFeeBps([0], { account: owner.account });

    const debtAfterClose = await vault.read.insuranceDebt();
    await vault.write.depositInsuranceFund([debtAfterClose], { account: owner.account });
    assert.equal(await vault.read.insuranceDebt(), 0n);
    assert.equal(await vault.read.halted(), true);

    await vault.write.setInsuranceDebtCap([1n], { account: owner.account });
    await vault.write.resume({ account: owner.account });
    assert.equal(await vault.read.halted(), false);
    await perps.write.createOrder([far, -parseUnits("1", config.quantityDecimals), TimeInForce.GTC], {
      account: buyer2.account,
    });
    await vault.write.withdraw([1n], { account: buyer.account });

    await vault.write.halt({ account: owner.account });
    await vault.write.resume({ account: owner.account });
    assert.equal(await vault.read.halted(), false);
  });

  it("borrows when an empty fund owes funding", async () => {
    const { contracts, accounts, config } = await networkHelpers.loadFixture(
      deployPerpsWithFundingAndPositionsFixture,
    );
    const { perps, vault } = contracts;
    const { buyer, seller, buyer2, owner } = accounts;
    const tick = config.minimumPriceIncrement;

    await perps.write.createOrder([config.marketPrice - 3n * tick, parseUnits("1", config.quantityDecimals), TimeInForce.GTC], {
      account: buyer2.account,
    });
    await perps.write.createOrder([config.marketPrice - tick, -parseUnits("1", config.quantityDecimals), TimeInForce.GTC], {
      account: seller.account,
    });

    const insurance = await vault.read.insuranceFundBalance();
    await vault.write.withdrawInsuranceFund([owner.account.address, insurance], { account: owner.account });
    await vault.write.setInsuranceDebtCap([parseUnits("1000000", config.tokenDecimals)], {
      account: owner.account,
    });

    await networkHelpers.time.increase(86400);
    const pending = await perps.read.getPendingFunding([buyer.account.address]);
    assert.ok(pending < 0n);

    const before = await vault.read.balanceOf([buyer.account.address]);
    const debtBefore = await vault.read.insuranceDebt();
    await perps.write.createOrder([tick, parseUnits("1", config.quantityDecimals), TimeInForce.GTC], {
      account: buyer.account,
    });
    const gained = (await vault.read.balanceOf([buyer.account.address])) - before;
    assert.equal(await perps.read.getPendingFunding([buyer.account.address]), 0n);
    assert.ok(gained > 0n);
    assert.equal(await vault.read.insuranceDebt(), debtBefore + gained);
    assert.equal(await vault.read.halted(), false);
  });

  it("records a trader funding shortfall as vault bad debt", async () => {
    const data = await networkHelpers.loadFixture(deployPerpsFixture);
    const { contracts, accounts, config, utils } = data;
    const { perps, vault } = contracts;
    const { seller, buyer, buyer2, owner, pc } = accounts;
    const entry = await perps.read.getMarketPrice();
    const qty = parseUnits("1", config.quantityDecimals);
    const tick = config.minimumPriceIncrement;

    await perps.write.setFundingParameters([1000n, 86400n], { account: owner.account });
    await perps.write.setTakerFeeBps([0], { account: owner.account });
    await perps.write.setMakerFeeBps([0], { account: owner.account });
    const minCollateral = utils.getMinimumCollateral(entry, qty);
    await vault.write.deposit([minCollateral], { account: buyer.account });
    await vault.write.deposit([minCollateral * 5n], { account: seller.account });
    await vault.write.deposit([minCollateral * 5n], { account: buyer2.account });
    await perps.write.createOrder([entry, -qty, TimeInForce.GTC], { account: seller.account });
    await perps.write.createOrder([entry, qty, TimeInForce.GTC], { account: buyer.account });
    await perps.write.createOrder([entry * 2n, parseUnits("0.1", config.quantityDecimals), TimeInForce.GTC], {
      account: buyer2.account,
    });
    await perps.write.createOrder([entry * 3n, -parseUnits("0.1", config.quantityDecimals), TimeInForce.GTC], {
      account: seller.account,
    });

    const insurance = await vault.read.insuranceFundBalance();
    await vault.write.withdrawInsuranceFund([owner.account.address, insurance], { account: owner.account });
    await vault.write.setInsuranceDebtCap([parseUnits("1000000", config.tokenDecimals)], {
      account: owner.account,
    });

    await networkHelpers.time.increase(86400 * 30);
    const pending = await perps.read.getPendingFunding([buyer.account.address]);
    const balance = await vault.read.balanceOf([buyer.account.address]);
    assert.ok(pending > balance, "funding owed should exceed the long's balance");

    const settleHash = await perps.write.createOrder(
      [entry * 5n, -parseUnits("0.1", config.quantityDecimals), TimeInForce.GTC],
      { account: buyer.account },
    );
    const receipt = await pc.waitForTransactionReceipt({ hash: settleHash });
    const debts = parseEventLogs({ logs: receipt.logs, abi: vault.abi, eventName: "BadDebt" }).filter(
      (evt) => evt.args.payer.toLowerCase() === buyer.account.address.toLowerCase(),
    );
    assert.ok(debts.length >= 1);
    assert.equal(await vault.read.balanceOf([buyer.account.address]), 0n);
  });

  it("settles funding during a liquidation while the vault is halted", async () => {
    const data = await networkHelpers.loadFixture(deployPerpsFixture);
    const { contracts, accounts, config, utils } = data;
    const { perps, pme, priceOracle, vault } = contracts;
    const { seller, buyer, buyer2, owner, pc } = accounts;

    await perps.write.setFundingParameters([100n, 86400n], { account: owner.account });
    const initialPrice = await perps.read.getMarketPrice();
    const qty = parseUnits("1", config.quantityDecimals);
    const tick = config.minimumPriceIncrement;
    const minCollateral = utils.getMinimumCollateral(initialPrice, qty);
    await vault.write.deposit([minCollateral], { account: seller.account });
    await vault.write.deposit([minCollateral * 2n], { account: buyer.account });
    await perps.write.createOrder([initialPrice, -qty, TimeInForce.GTC], { account: seller.account });
    await perps.write.createOrder([initialPrice, qty, TimeInForce.GTC], { account: buyer.account });
    await perps.write.createOrder([initialPrice + tick, parseUnits("0.1", config.quantityDecimals), TimeInForce.GTC], {
      account: buyer.account,
    });
    await perps.write.createOrder([initialPrice + 3n * tick, -parseUnits("0.1", config.quantityDecimals), TimeInForce.GTC], {
      account: seller.account,
    });
    await networkHelpers.time.increase(86400);
    await priceOracle.write.setPrice([initialPrice * 2n, config.oracle.decimals]);
    assert.equal(await pme.read.isLiquidatable([seller.account.address]), true);

    await vault.write.halt({ account: owner.account });
    const sellerOrders = await perps.read.getUserOrders([seller.account.address]);
    await perps.write.liquidateOrders([seller.account.address, sellerOrders], { account: buyer2.account });
    const hash = await perps.write.liquidatePosition([seller.account.address, maxUint256], {
      account: buyer2.account,
    });
    const receipt = await pc.waitForTransactionReceipt({ hash });
    const settled = parseEventLogs({ logs: receipt.logs, abi: perps.abi, eventName: "FundingSettled" });
    assert.ok(settled.some((evt) => evt.args.user.toLowerCase() === seller.account.address.toLowerCase()));
    assert.equal((await perps.read.getUserPosition([seller.account.address])).netQuantity, 0n);
    assert.equal(await perps.read.getPendingFunding([seller.account.address]), 0n);
    assert.equal(await vault.read.halted(), true);
  });
});
