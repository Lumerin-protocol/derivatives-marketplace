import { describe, test, beforeEach, clearStore } from "matchstick-as/assembly/index";
import { BigInt } from "@graphprotocol/graph-ts";
import { newTypedMockEventWithParams } from "matchstick-as/assembly/defaults";
import { handleFundingUpdated } from "../src/perps";
import { FundingUpdated } from "../generated/PerpsSimple/PerpsSimple";
import { assert } from "matchstick-as/assembly/index";
import { mockEventId, setupDataSourceMock, paramInt, paramUint, setupPerps } from "./helpers";

function createFundingUpdatedEvent(
  fundingRate: BigInt,
  cumulativeFundingPerUnit: BigInt,
  timestamp: BigInt,
  logIndex: i32 = 1,
): FundingUpdated {
  const event = newTypedMockEventWithParams<FundingUpdated>([
    paramInt("fundingRate", fundingRate),
    paramInt("cumulativeFundingPerUnit", cumulativeFundingPerUnit),
    paramUint("timestamp", timestamp),
  ]);
  event.logIndex = BigInt.fromI32(logIndex);
  return event;
}

describe("handleFundingUpdated", () => {
  beforeEach(() => {
    clearStore();
    setupDataSourceMock();
    setupPerps();
  });

  test("creates FundingUpdate entity with all fields and updates Perps", () => {
    const fundingRate = BigInt.fromI32(500);
    const cumFunding = BigInt.fromI32(12000);
    const fundingTs = BigInt.fromI32(1700000000);

    const event = createFundingUpdatedEvent(fundingRate, cumFunding, fundingTs);
    handleFundingUpdated(event);

    const eventId = mockEventId(1);

    assert.entityCount("FundingUpdate", 1);
    assert.fieldEquals("FundingUpdate", eventId, "fundingRate", fundingRate.toString());
    assert.fieldEquals("FundingUpdate", eventId, "cumulativeFundingPerUnit", cumFunding.toString());
    assert.fieldEquals("FundingUpdate", eventId, "timestamp", fundingTs.toString());
    assert.fieldEquals("FundingUpdate", eventId, "blockNumber", event.block.number.toString());
    assert.fieldEquals("FundingUpdate", eventId, "transactionHash", event.transaction.hash.toHexString());

    assert.fieldEquals("Perps", "0", "cumulativeFundingPerUnit", cumFunding.toString());
    assert.fieldEquals("Perps", "0", "lastFundingUpdateTime", fundingTs.toString());
    assert.fieldEquals("Perps", "0", "lastUpdatedAt", event.block.timestamp.toString());
  });

  test("second update overwrites Perps fields, both events exist", () => {
    const rate1 = BigInt.fromI32(500);
    const cum1 = BigInt.fromI32(12000);
    const ts1 = BigInt.fromI32(1700000000);
    const rate2 = BigInt.fromI32(-300);
    const cum2 = BigInt.fromI32(11700);
    const ts2 = BigInt.fromI32(1700003600);

    handleFundingUpdated(createFundingUpdatedEvent(rate1, cum1, ts1, 1));
    handleFundingUpdated(createFundingUpdatedEvent(rate2, cum2, ts2, 2));

    assert.entityCount("FundingUpdate", 2);

    assert.fieldEquals("FundingUpdate", mockEventId(1), "fundingRate", rate1.toString());
    assert.fieldEquals("FundingUpdate", mockEventId(2), "fundingRate", rate2.toString());

    assert.fieldEquals("Perps", "0", "cumulativeFundingPerUnit", cum2.toString());
    assert.fieldEquals("Perps", "0", "lastFundingUpdateTime", ts2.toString());
  });
});
