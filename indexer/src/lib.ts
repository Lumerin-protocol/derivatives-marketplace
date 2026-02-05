import { Bytes, ByteArray } from "@graphprotocol/graph-ts/common/collections";
import { BigInt } from "@graphprotocol/graph-ts/common/numbers";

export function unpackBools(packed: i32): boolean[] {
  return [(packed & 1) != 0, (packed & (1 << 1)) != 0];
}

export function concatU64s(a: u64, b: u64): Bytes {
  // Convert u64 to ByteArray with BigEndian representation
  const aByteArray = ByteArray.fromU64(a).reverse();
  const bByteArray = ByteArray.fromU64(b).reverse();

  // Concatenate the two 8-byte u64 values for 16 bytes total
  const result = new ByteArray(16); // 8 bytes for each u64

  // Set first u64 (a) at bytes 0-7
  result.set(aByteArray, 0);

  // Set second u64 (b) at bytes 8-15
  result.set(bByteArray, 8);

  return changetype<Bytes>(result);
}

export function bigIntToBytes(a: BigInt): Bytes {
  const byteArray = ByteArray.fromBigInt(a);
  // slice is needed to avoid overwriting the original byte array
  // have no idea why that happens, but it does
  return changetype<Bytes>(byteArray.slice().reverse());
}
