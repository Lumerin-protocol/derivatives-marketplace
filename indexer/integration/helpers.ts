import type { Hex } from "viem";

function padLeft(s: string, len: number): string {
  return s.length >= len ? s : "0".repeat(len - s.length) + s;
}

/**
 * Mirrors `positionSessionId` in `src/ids.ts`:
 *   blockNumber (12 digits) ++ logIndex (6 digits) ++ side (2 digits),
 *   all zero-padded, where side is taker=0 / maker=1.
 */
export function positionSessionId(
  blockNumber: bigint,
  logIndex: number,
  side: number,
): string {
  return (
    padLeft(blockNumber.toString(), 12) +
    padLeft(logIndex.toString(), 6) +
    padLeft(side.toString(), 2)
  );
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
