import { BigInt } from "@graphprotocol/graph-ts";

export function isSameSign(a: BigInt, b: BigInt): boolean {
  const zero = BigInt.zero();
  return (a.gt(zero) && b.gt(zero)) || (a.lt(zero) && b.lt(zero));
}
