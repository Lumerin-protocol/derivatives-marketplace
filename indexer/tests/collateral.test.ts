import { describe, test, beforeEach, clearStore } from "matchstick-as/assembly/index";
import { Address, BigInt } from "@graphprotocol/graph-ts";
import { newTypedMockEventWithParams } from "matchstick-as/assembly/defaults";
import { handleCollateralAdded, handleCollateralRemoved } from "../src/perps";
import { CollateralAdded, CollateralRemoved } from "../generated/PerpsSimple/PerpsSimple";
import { assert } from "matchstick-as/assembly/index";
import { userAddress, paramAddr, paramUint, setupDataSourceMock } from "./helpers";
import { createEventId } from "../src/ids";
describe("handleCollateralAdded", () => {
  beforeEach(() => {
    clearStore();
    setupDataSourceMock();
  });

  test("creates user, collateral event and updates user balance", () => {
    const address = userAddress(1);
    const event = createCollateralAddedEvent(address, BigInt.fromI32(1000000));
    const eventId = createEventId(event.transaction.hash, event.logIndex);

    handleCollateralAdded(event);

    assert.entityCount("User", 1);
    assert.entityCount("CollateralEvent", 1);

    assert.fieldEquals("User", address.toHexString(), "collateralBalance", event.params.amount.toString());
    assert.fieldEquals("User", address.toHexString(), "totalDeposited", event.params.amount.toString());

    assert.fieldEquals("CollateralEvent", eventId.toHexString(), "amount", event.params.amount.toString());
    assert.fieldEquals("CollateralEvent", eventId.toHexString(), "isDeposit", "true");
  });

  test("adds to existing user collateral", () => {
    const address = userAddress(1);
    const event1 = createCollateralAddedEvent(address, BigInt.fromI32(500), 1);
    const event2 = createCollateralAddedEvent(address, BigInt.fromI32(300), 2);
    const event1Id = createEventId(event1.transaction.hash, event1.logIndex);
    const event2Id = createEventId(event2.transaction.hash, event2.logIndex);

    handleCollateralAdded(event1);
    handleCollateralAdded(event2);

    const collateralBalance = event1.params.amount.plus(event2.params.amount);
    const totalDeposited = event1.params.amount.plus(event2.params.amount);

    assert.entityCount("CollateralEvent", 2);
    assert.fieldEquals(
      "User",
      address.toHexString(),
      "collateralBalance",
      collateralBalance.toString(),
    );
    assert.fieldEquals("User", address.toHexString(), "totalDeposited", totalDeposited.toString());
    assert.fieldEquals(
      "CollateralEvent",
      event1Id.toHexString(),
      "amount",
      event1.params.amount.toString(),
    );
    assert.fieldEquals(
      "CollateralEvent",
      event2Id.toHexString(),
      "amount",
      event2.params.amount.toString(),
    );
  });
});

describe("handleCollateralRemoved", () => {
  beforeEach(() => {
    clearStore();
    setupDataSourceMock();
  });

  test("creates user, collateral event and decrements user balance", () => {
    const address = userAddress(1);
    const addEvent = createCollateralAddedEvent(address, BigInt.fromI32(1000000));
    const removeEvent = createCollateralRemovedEvent(address, BigInt.fromI32(300000));

    handleCollateralAdded(addEvent);
    handleCollateralRemoved(removeEvent);

    const collateralBalance = addEvent.params.amount.minus(removeEvent.params.amount);

    assert.fieldEquals("User", address.toHexString(), "collateralBalance", collateralBalance.toString());
    assert.fieldEquals("User", address.toHexString(), "totalWithdrawn", removeEvent.params.amount.toString());
  });
});

function createCollateralAddedEvent(
  user: Address,
  amount: BigInt,
  logIndex: i32 = 1,
): CollateralAdded {
  const event = newTypedMockEventWithParams<CollateralAdded>([
    paramAddr("user", user),
    paramUint("amount", amount),
  ]);
  event.logIndex = BigInt.fromI32(logIndex);
  return event;
}

function createCollateralRemovedEvent(user: Address, amount: BigInt, logIndex: i32 = 2): CollateralRemoved {
  const event = newTypedMockEventWithParams<CollateralRemoved>([
    paramAddr("user", user),
    paramUint("amount", amount),
  ]);
  event.logIndex = BigInt.fromI32(logIndex);
  return event;
}
