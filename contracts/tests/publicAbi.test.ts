import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HashPowerPerpsDEXAbi } from "../abi/HashPowerPerpsDEX.ts";
import { network } from "hardhat";
import { deployPerpsWithCollateralFixture } from "./fixtures.ts";

const { networkHelpers } = await network.getOrCreate();

type AbiParameter = {
  readonly name: string;
  readonly type: string;
  readonly indexed?: boolean;
  readonly components?: readonly AbiParameter[];
};

type AbiItem = {
  readonly type: string;
  readonly name?: string;
  readonly inputs?: readonly AbiParameter[];
  readonly outputs?: readonly AbiParameter[];
};

function getItem(type: string, name: string): AbiItem {
  const item = (HashPowerPerpsDEXAbi as readonly AbiItem[]).find(
    (candidate) => candidate.type === type && candidate.name === name,
  );
  assert.ok(item, `missing ${type} ${name}`);
  return item;
}

describe("HashPowerPerpsDEX - public ABI", function () {
  it("exposes the v3 version and six-decimal quantity scale", async function () {
    const { contracts } = await networkHelpers.loadFixture(deployPerpsWithCollateralFixture);

    assert.equal(await contracts.perps.read.VERSION(), "3.0.0");
    assert.equal(await contracts.perps.read.QUANTITY_DECIMALS(), 6);
  });

  it("uses the canonical Futures errors", function () {
    const abiErrors = new Set(
      (HashPowerPerpsDEXAbi as readonly AbiItem[])
        .filter((item) => item.type === "error")
        .map((item) => item.name),
    );

    assert.ok(abiErrors.has("InvalidQty"));
    assert.ok(abiErrors.has("InsufficientMarginBalance"));
    assert.ok(abiErrors.has("ValueOutOfRange"));
    assert.ok(abiErrors.has("OrderMarginTooLow"));
    assert.ok(!abiErrors.has("InvalidSize"));
    assert.ok(!abiErrors.has("InsufficientMargin"));
    assert.ok(!abiErrors.has("InvalidMarginPercent"));
    assert.deepEqual(
      getItem("error", "ValueOutOfRange").inputs?.map(({ name, type }) => ({ name, type })),
      [
        { name: "min", type: "int256" },
        { name: "max", type: "int256" },
      ],
    );
  });

  it("uses canonical output and liquidation parameter names", function () {
    assert.deepEqual(
      getItem("function", "getOrderBookPrices").outputs?.map(({ name }) => name),
      ["bids", "asks"],
    );
    assert.deepEqual(getItem("function", "getUserOrders").outputs?.map(({ name }) => name), [
      "orderIds",
    ]);
    assert.deepEqual(getItem("function", "getOrderAggregate").outputs?.map(({ name }) => name), [
      "aggregate_",
    ]);
    assert.deepEqual(getItem("function", "getQuantityAtPrice").outputs?.map(({ name }) => name), [
      "",
    ]);
    assert.deepEqual(getItem("function", "getRiskView").outputs?.map(({ name }) => name), ["view_"]);
    assert.deepEqual(getItem("function", "getUnrealizedPnl").outputs?.map(({ name }) => name), [""]);

    const position = getItem("function", "getUserPosition").outputs?.[0];
    assert.deepEqual(
      position?.components?.map(({ name, type }) => ({ name, type })),
      [
        { name: "netQuantity", type: "int256" },
        { name: "netEntryValue", type: "int256" },
      ],
    );

    assert.deepEqual(
      getItem("event", "PositionLiquidated").inputs?.map(({ name, type, indexed }) => ({
        name,
        type,
        indexed,
      })),
      [
        { name: "user", type: "address", indexed: true },
        { name: "liquidator", type: "address", indexed: true },
        { name: "closedQuantity", type: "int256", indexed: false },
        { name: "pnl", type: "int256", indexed: false },
        { name: "liquidatorFee", type: "uint256", indexed: false },
      ],
    );
  });
});
