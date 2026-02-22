/**
 * Deterministic test data generators and event param helpers.
 * AssemblyScript has no Math.random, so we use seeds for reproducible, meaningful IDs.
 */
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { dataSourceMock } from "matchstick-as/assembly/index";

function padLeft(s: string, len: i32, char: string): string {
  while (s.length < len) {
    s = char + s;
  }
  return s;
}

/** Deterministic address from numeric id. e.g. userAddress(1) => 0x00...01 */
export function userAddress(id: i32): Address {
  const hex = padLeft(id.toString(16), 40, "0");
  return Address.fromString("0x" + hex);
}

/** Perps contract address for dataSourceMock. Distinct from user ids 1, 2, ... */
export function contractAddress(): Address {
  return userAddress(255); // 0x00...ff
}

/** Mock dataSource.address() to avoid "No mocked Eth address" warning. Call in beforeEach. */
export function setupDataSourceMock(): void {
  dataSourceMock.setAddress(contractAddress().toHexString());
}

/** Deterministic 32-byte order ID from seed. e.g. orderId(1) => 0x00...01 */
export function orderId(seed: i32): Bytes {
  const hex = padLeft(seed.toString(16), 64, "0");
  return Bytes.fromHexString("0x" + hex) as Bytes;
}

/** Event param helpers to avoid verbose ethereum.EventParam / ethereum.Value nesting */
export function paramAddr(name: string, value: Address): ethereum.EventParam {
  return new ethereum.EventParam(name, ethereum.Value.fromAddress(value));
}

export function paramBytes(name: string, value: Bytes): ethereum.EventParam {
  return new ethereum.EventParam(name, ethereum.Value.fromBytes(value));
}

export function paramUint(name: string, value: BigInt): ethereum.EventParam {
  return new ethereum.EventParam(name, ethereum.Value.fromUnsignedBigInt(value));
}

export function paramInt(name: string, value: BigInt): ethereum.EventParam {
  return new ethereum.EventParam(name, ethereum.Value.fromSignedBigInt(value));
}

/** Price level ID for assertions. e.g. priceLevel(price, true) => "{price}-bid" */
export function priceLevel(price: BigInt, isBid: boolean): string {
  return price.toString() + (isBid ? "-bid" : "-ask");
}

/** Tx hash from matchstick mock defaults */
const MOCK_TX_HASH = Bytes.fromHexString(
  "0xa16081f360e3847006db660bae1c6d1b2e17ec2a",
) as Bytes;

/**
 * CollateralEvent/Liquidation/etc. id from matchstick mock defaults.
 * createEventId = txHash.concatI32(logIndex).
 */
export function mockEventId(logIndex: i32 = 1): string {
  return MOCK_TX_HASH.concatI32(logIndex).toHexString();
}
