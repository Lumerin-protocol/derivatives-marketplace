import { BigInt } from "@graphprotocol/graph-ts";

export function isSameSign(a: BigInt, b: BigInt): boolean {
  const zero = BigInt.zero();
  return (a.gt(zero) && b.gt(zero)) || (a.lt(zero) && b.lt(zero));
}

export function absBigInt(value: BigInt): BigInt {
  return value.lt(BigInt.zero()) ? value.neg() : value;
}

export function minBigInt(a: BigInt, b: BigInt): BigInt {
  return a.lt(b) ? a : b;
}
