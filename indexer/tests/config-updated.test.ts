import { describe, test, beforeEach, clearStore } from "matchstick-as/assembly/index";
import { BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { newTypedMockEventWithParams } from "matchstick-as/assembly/defaults";
import {
  handleMatchFeeUpdated,
  handleMarginPercentUpdated,
  handleMaintenanceMarginPercentUpdated,
  handleLiquidationFeeUpdated,
  handleFundingParametersUpdated,
  handleMinimumMarginPerOrderUpdated,
} from "../src/perps";
import {
  MatchFeeUpdated,
  MarginPercentUpdated,
  MaintenanceMarginPercentUpdated,
  LiquidationFeeUpdated,
  FundingParametersUpdated,
  MinimumMarginPerOrderUpdated,
} from "../generated/PerpsSimple/PerpsSimple";
import { Perps } from "../generated/schema";
import { assert } from "matchstick-as/assembly/index";
import { setupDataSourceMock, paramUint } from "./helpers";

function paramI32(name: string, value: i32): ethereum.EventParam {
  return new ethereum.EventParam(name, ethereum.Value.fromI32(value));
}

function setupPerps(): void {
  const perps = new Perps(0);
  perps.contractAddress = Bytes.empty();
  perps.collateralToken = Bytes.empty();
  perps.priceOracle = Bytes.empty();
  perps.quantityDecimals = 6;
  perps.minimumPriceIncrement = BigInt.zero();
  perps.marginPercent = 0;
  perps.maintenanceMarginPercent = 0;
  perps.liquidationFee = BigInt.zero();
  perps.takerFeeBps = 0;
  perps.makerFeeBps = 0;
  perps.fundingRateMaxBps = BigInt.zero();
  perps.fundingPeriod = BigInt.zero();
  perps.cumulativeFundingPerUnit = BigInt.zero();
  perps.lastFundingUpdateTime = BigInt.zero();
  perps.minimumMarginPerOrder = BigInt.zero();
  perps.reservePoolBalance = BigInt.zero();
  perps.collectedFeesBalance = BigInt.zero();
  perps.totalUsers = 0;
  perps.totalOrders = 0;
  perps.activeOrders = 0;
  perps.totalTrades = 0;
  perps.totalVolume = BigInt.zero();
  perps.totalLiquidations = 0;
  perps.totalBadDebt = BigInt.zero();
  perps.initializedAt = BigInt.zero();
  perps.lastUpdatedAt = BigInt.zero();
  perps.save();
}

describe("config update handlers", () => {
  beforeEach(() => {
    clearStore();
    setupDataSourceMock();
    setupPerps();
  });

  test("handleMatchFeeUpdated sets takerFeeBps and makerFeeBps", () => {
    const event = newTypedMockEventWithParams<MatchFeeUpdated>([
      paramI32("newTakerFeeBps", 30),
      paramI32("newMakerFeeBps", -10),
    ]);
    handleMatchFeeUpdated(event);

    assert.fieldEquals("Perps", "0", "takerFeeBps", "30");
    assert.fieldEquals("Perps", "0", "makerFeeBps", "-10");
    assert.fieldEquals("Perps", "0", "lastUpdatedAt", event.block.timestamp.toString());
  });

  test("handleMarginPercentUpdated sets marginPercent", () => {
    const event = newTypedMockEventWithParams<MarginPercentUpdated>([
      paramI32("newMarginPercent", 10),
    ]);
    handleMarginPercentUpdated(event);

    assert.fieldEquals("Perps", "0", "marginPercent", "10");
    assert.fieldEquals("Perps", "0", "lastUpdatedAt", event.block.timestamp.toString());
  });

  test("handleMaintenanceMarginPercentUpdated sets maintenanceMarginPercent", () => {
    const event = newTypedMockEventWithParams<MaintenanceMarginPercentUpdated>([
      paramI32("newMaintenanceMarginPercent", 5),
    ]);
    handleMaintenanceMarginPercentUpdated(event);

    assert.fieldEquals("Perps", "0", "maintenanceMarginPercent", "5");
    assert.fieldEquals("Perps", "0", "lastUpdatedAt", event.block.timestamp.toString());
  });

  test("handleLiquidationFeeUpdated sets liquidationFee", () => {
    const liqFee = BigInt.fromI32(25000);
    const event = newTypedMockEventWithParams<LiquidationFeeUpdated>([
      paramUint("newLiquidationFee", liqFee),
    ]);
    handleLiquidationFeeUpdated(event);

    assert.fieldEquals("Perps", "0", "liquidationFee", liqFee.toString());
    assert.fieldEquals("Perps", "0", "lastUpdatedAt", event.block.timestamp.toString());
  });

  test("handleFundingParametersUpdated sets fundingRateMaxBps and fundingPeriod", () => {
    const maxBps = BigInt.fromI32(100);
    const period = BigInt.fromI32(28800);
    const event = newTypedMockEventWithParams<FundingParametersUpdated>([
      paramUint("maxBps", maxBps),
      paramUint("period", period),
    ]);
    handleFundingParametersUpdated(event);

    assert.fieldEquals("Perps", "0", "fundingRateMaxBps", maxBps.toString());
    assert.fieldEquals("Perps", "0", "fundingPeriod", period.toString());
    assert.fieldEquals("Perps", "0", "lastUpdatedAt", event.block.timestamp.toString());
  });

  test("handleMinimumMarginPerOrderUpdated sets minimumMarginPerOrder", () => {
    const minMargin = BigInt.fromI32(500000);
    const event = newTypedMockEventWithParams<MinimumMarginPerOrderUpdated>([
      paramUint("newMinimumMarginPerOrder", minMargin),
    ]);
    handleMinimumMarginPerOrderUpdated(event);

    assert.fieldEquals("Perps", "0", "minimumMarginPerOrder", minMargin.toString());
    assert.fieldEquals("Perps", "0", "lastUpdatedAt", event.block.timestamp.toString());
  });
});
