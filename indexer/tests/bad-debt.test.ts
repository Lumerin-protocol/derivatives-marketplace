import { describe, test, beforeEach, clearStore } from "matchstick-as/assembly/index";
import { Address, BigInt } from "@graphprotocol/graph-ts";
import { newTypedMockEventWithParams } from "matchstick-as/assembly/defaults";
import { handleBadDebt } from "../src/perps";
import { BadDebt } from "../generated/PerpsSimple/PerpsSimple";
import { assert } from "matchstick-as/assembly/index";
import { userAddress, paramAddr, paramUint, mockEventId, setupDataSourceMock, setupPerps } from "./helpers";

function createBadDebtEvent(
  user: Address,
  amount: BigInt,
  logIndex: i32 = 1,
): BadDebt {
  const event = newTypedMockEventWithParams<BadDebt>([
    paramAddr("user", user),
    paramUint("amount", amount),
  ]);
  event.logIndex = BigInt.fromI32(logIndex);
  return event;
}

describe("handleBadDebt", () => {
  beforeEach(() => {
    clearStore();
    setupDataSourceMock();
    setupPerps();
  });

  test("creates BadDebtEvent with all fields and updates Perps totalBadDebt", () => {
    const address = userAddress(1);
    const amount = BigInt.fromI32(50000);

    const event = createBadDebtEvent(address, amount);
    handleBadDebt(event);

    const eventId = mockEventId(1);

    assert.entityCount("BadDebtEvent", 1);
    assert.fieldEquals("BadDebtEvent", eventId, "user", address.toHexString());
    assert.fieldEquals("BadDebtEvent", eventId, "amount", amount.toString());
    assert.fieldEquals("BadDebtEvent", eventId, "timestamp", event.block.timestamp.toString());
    assert.fieldEquals("BadDebtEvent", eventId, "blockNumber", event.block.number.toString());
    assert.fieldEquals("BadDebtEvent", eventId, "transactionHash", event.transaction.hash.toHexString());

    assert.fieldEquals("Perps", "0", "totalBadDebt", amount.toString());
    assert.fieldEquals("Perps", "0", "lastUpdatedAt", event.block.timestamp.toString());
  });

  test("accumulates totalBadDebt across multiple events", () => {
    const user1 = userAddress(1);
    const user2 = userAddress(2);
    const amount1 = BigInt.fromI32(50000);
    const amount2 = BigInt.fromI32(30000);

    handleBadDebt(createBadDebtEvent(user1, amount1, 1));
    handleBadDebt(createBadDebtEvent(user2, amount2, 2));

    assert.entityCount("BadDebtEvent", 2);
    assert.fieldEquals("Perps", "0", "totalBadDebt", amount1.plus(amount2).toString());
  });
});
