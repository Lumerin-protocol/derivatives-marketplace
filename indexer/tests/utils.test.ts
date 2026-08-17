import { describe, test } from "matchstick-as/assembly/index";
import { BigInt } from "@graphprotocol/graph-ts";
import { positionSessionId } from "../src/ids";
import { isSameSign } from "../src/lib";
import { assert } from "matchstick-as/assembly/index";

describe("positionSessionId", () => {
  test("pads block to 12 digits, log index to 6, side to 2", () => {
    const id = positionSessionId(BigInt.fromI32(1), BigInt.fromI32(1), 0);
    assert.assertTrue(id == "00000000000100000100");
  });

  test("handles zero block and zero log index", () => {
    const id = positionSessionId(BigInt.zero(), BigInt.zero(), 0);
    assert.assertTrue(id == "00000000000000000000");
  });

  test("handles large values", () => {
    const blockNumber = BigInt.fromI32(1234567890);
    const id = positionSessionId(blockNumber, BigInt.fromI32(999999), 1);
    // block padded to 12 digits: 001234567890, logIndex to 6: 999999, side to 2: 01
    assert.assertTrue(id == "00123456789099999901");
  });

  test("does not truncate when block exceeds 12 digits", () => {
    const blockNumber = BigInt.fromString("9999999999999");
    const id = positionSessionId(blockNumber, BigInt.zero(), 0);
    assert.assertTrue(id == "999999999999900000000");
  });

  test("side disambiguates the two sessions one match can open", () => {
    const taker = positionSessionId(BigInt.fromI32(7), BigInt.fromI32(3), 0);
    const maker = positionSessionId(BigInt.fromI32(7), BigInt.fromI32(3), 1);
    assert.assertTrue(taker != maker);
  });
});

describe("isSameSign", () => {
  test("returns true for both positive", () => {
    assert.assertTrue(isSameSign(BigInt.fromI32(1), BigInt.fromI32(100)));
  });

  test("returns true for both negative", () => {
    assert.assertTrue(isSameSign(BigInt.fromI32(-1), BigInt.fromI32(-100)));
  });

  test("returns false for opposite signs", () => {
    assert.assertTrue(!isSameSign(BigInt.fromI32(1), BigInt.fromI32(-1)));
  });

  test("returns false for zero with positive", () => {
    assert.assertTrue(!isSameSign(BigInt.zero(), BigInt.fromI32(1)));
  });

  test("returns false for zero with negative", () => {
    assert.assertTrue(!isSameSign(BigInt.zero(), BigInt.fromI32(-1)));
  });

  test("returns false for positive with zero", () => {
    assert.assertTrue(!isSameSign(BigInt.fromI32(1), BigInt.zero()));
  });
});
