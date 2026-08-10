import { describe, test, beforeEach, clearStore } from "matchstick-as/assembly/index";
import { Address, BigInt, ethereum } from "@graphprotocol/graph-ts";
import { newTypedMockEventWithParams } from "matchstick-as/assembly/defaults";
import {
  handleMakerFeeBpsUpdated,
  handleTakerFeeBpsUpdated,
  handleLiquidationFeeBpsUpdated,
  handleLiquidatorShareBpsUpdated,
  handleOracleUpdated,
  handlePortfolioMarginUpdated,
  handleFundingParametersUpdated,
  handleMinimumMarginPerOrderUpdated,
} from "../src/perps";
import {
  MakerFeeBpsUpdated,
  TakerFeeBpsUpdated,
  LiquidationFeeBpsUpdated,
  LiquidatorShareBpsUpdated,
  OracleUpdated,
  PortfolioMarginUpdated,
  FundingParametersUpdated,
  MinimumMarginPerOrderUpdated,
} from "../generated/HashPowerPerpsDEX/HashPowerPerpsDEX";
import { assert } from "matchstick-as/assembly/index";
import { setupDataSourceMock, paramUint, setupPerps } from "./helpers";

function paramI32(name: string, value: i32): ethereum.EventParam {
  return new ethereum.EventParam(name, ethereum.Value.fromI32(value));
}

describe("config update handlers", () => {
  beforeEach(() => {
    clearStore();
    setupDataSourceMock();
    setupPerps();
  });

  test("handleMakerFeeBpsUpdated sets makerFeeBps", () => {
    const event = newTypedMockEventWithParams<MakerFeeBpsUpdated>([
      paramI32("newMakerFeeBps", -5),
    ]);
    handleMakerFeeBpsUpdated(event);

    assert.fieldEquals("Perps", "0", "makerFeeBps", "-5");
    assert.fieldEquals("Perps", "0", "lastUpdatedAt", event.block.timestamp.toString());
  });

  test("handleTakerFeeBpsUpdated sets takerFeeBps", () => {
    const event = newTypedMockEventWithParams<TakerFeeBpsUpdated>([
      paramI32("newTakerFeeBps", 20),
    ]);
    handleTakerFeeBpsUpdated(event);

    assert.fieldEquals("Perps", "0", "takerFeeBps", "20");
    assert.fieldEquals("Perps", "0", "lastUpdatedAt", event.block.timestamp.toString());
  });

  test("handleLiquidationFeeBpsUpdated sets liquidationFeeBps", () => {
    const event = newTypedMockEventWithParams<LiquidationFeeBpsUpdated>([
      paramI32("newLiquidationFeeBps", 50),
    ]);
    handleLiquidationFeeBpsUpdated(event);

    assert.fieldEquals("Perps", "0", "liquidationFeeBps", "50");
    assert.fieldEquals("Perps", "0", "lastUpdatedAt", event.block.timestamp.toString());
  });

  test("handleLiquidatorShareBpsUpdated sets liquidatorShareBps", () => {
    const event = newTypedMockEventWithParams<LiquidatorShareBpsUpdated>([
      paramI32("newLiquidatorShareBps", 2500),
    ]);
    handleLiquidatorShareBpsUpdated(event);

    assert.fieldEquals("Perps", "0", "liquidatorShareBps", "2500");
    assert.fieldEquals("Perps", "0", "lastUpdatedAt", event.block.timestamp.toString());
  });

  test("handleOracleUpdated sets priceOracle", () => {
    const oracle = Address.fromString(
      "0x1111111111111111111111111111111111111111",
    );
    const event = newTypedMockEventWithParams<OracleUpdated>([
      new ethereum.EventParam("newOracle", ethereum.Value.fromAddress(oracle)),
    ]);
    handleOracleUpdated(event);

    assert.fieldEquals("Perps", "0", "priceOracle", oracle.toHexString());
    assert.fieldEquals("Perps", "0", "lastUpdatedAt", event.block.timestamp.toString());
  });

  test("handlePortfolioMarginUpdated sets portfolioMarginEngine", () => {
    const engine = Address.fromString(
      "0x2222222222222222222222222222222222222222",
    );
    const event = newTypedMockEventWithParams<PortfolioMarginUpdated>([
      new ethereum.EventParam(
        "newPortfolioMargin",
        ethereum.Value.fromAddress(engine),
      ),
    ]);
    handlePortfolioMarginUpdated(event);

    assert.fieldEquals("Perps", "0", "portfolioMarginEngine", engine.toHexString());
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
