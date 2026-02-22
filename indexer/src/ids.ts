import { BigInt, Bytes } from "@graphprotocol/graph-ts";

function padLeft(s: string, len: i32, char: string): string {
  if (s.length >= len) return s;
  let out = "";
  for (let i = 0; i < len - s.length; i++) out += char;
  return out + s;
}

/** Deterministic position session ID: blockNumber (12 digits) + logIndex (6 digits). Stable regardless of indexer start block. */
export function positionSessionId(blockNumber: BigInt, logIndex: i32): string {
  return padLeft(blockNumber.toString(), 12, "0") + padLeft(logIndex.toString(), 6, "0");
}

export function createEventId(transactionHash: Bytes, logIndex: BigInt): Bytes {
  return transactionHash.concatI32(logIndex.toI32());
}

export function getPriceLevelId(price: BigInt, isBid: boolean): string {
  return price.toString() + "-" + (isBid ? "bid" : "ask");
}
