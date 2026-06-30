import type { Hex } from "viem";

function padLeft(s: string, len: number): string {
  return s.length >= len ? s : "0".repeat(len - s.length) + s;
}

/**
 * Mirrors `positionSessionId` in `src/ids.ts`:
 *   blockNumber (12 digits, zero-padded) ++ logIndex (6 digits, zero-padded).
 *
 * Note: handlers derive the session's `logIndex` slot as
 * `event.logIndex * 2 + sideIndex` (taker=0, maker=1), so callers that need
 * the exact id must pass that derived slot, not the raw event logIndex.
 */
export function positionSessionId(blockNumber: bigint, logIndex: number): string {
  return padLeft(blockNumber.toString(), 12) + padLeft(logIndex.toString(), 6);
}

/**
 * Mirrors `getPriceLevelId` in `src/ids.ts`:
 *   "{price}-bid" | "{price}-ask"
 */
export function priceLevelId(price: bigint, isBid: boolean): string {
  return `${price.toString()}-${isBid ? "bid" : "ask"}`;
}

/**
 * Mirrors `createEventId` in `src/ids.ts`:
 *   32-byte tx hash ++ 4-byte little-endian-free (big-endian) i32 logIndex.
 *
 * Matches `Bytes.concatI32`, which appends the i32 in big-endian order.
 */
export function eventId(transactionHash: Hex, logIndex: number): Hex {
  const tail = padLeft((logIndex >>> 0).toString(16), 8);
  return `${transactionHash.toLowerCase()}${tail}` as Hex;
}
