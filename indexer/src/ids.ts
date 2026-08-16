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

/**
 * Sentinel byte placed between concatenated id components. `0xff` is chosen
 * because `positionSessionId` digits (UTF-8 encoded) cannot contain it — so a
 * `0xff` byte cannot accidentally appear inside a component. Without a
 * separator, components like the user address (always 20 B) and `sessionId`
 * (variable length string) could in principle collide across different inputs.
 */
const ID_SEP: Bytes = Bytes.fromHexString("0xff") as Bytes;

/**
 * Trade aggregate id: tx hash ++ sep ++ user ++ sep ++ sessionId.
 * `sessionId` is included so that a single tx spanning more than one
 * PositionSession (a flip closes one session and opens another) produces one
 * Trade row per session — otherwise the reversal's two legs collapse into one
 * row and the freshly-opened session inherits the closed session's realizedPnl.
 */
export function tradeId(transactionHash: Bytes, user: Bytes, sessionId: string): Bytes {
  return transactionHash
    .concat(ID_SEP)
    .concat(user)
    .concat(ID_SEP)
    .concat(Bytes.fromUTF8(sessionId));
}

/**
 * Per-leg Fill id: tx hash ++ log index ++ leg index. Fills are immutable, one
 * per (OrderMatched, side), so the leg index disambiguates the taker leg from
 * the maker leg — and, on a flip, the closing leg from the re-opening one.
 */
export function fillId(transactionHash: Bytes, logIndex: BigInt, legIndex: i32): Bytes {
  return transactionHash.concatI32(logIndex.toI32()).concatI32(legIndex);
}

export function getPriceLevelId(price: BigInt, isBid: boolean): string {
  return price.toString() + "-" + (isBid ? "bid" : "ask");
}
