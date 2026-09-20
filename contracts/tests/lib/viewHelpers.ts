import type { Address } from "viem";

type PerpsReader = {
  read: {
    getUserPosition: (
      args: readonly [Address],
    ) => Promise<{ netQuantity: bigint; netEntryValue: bigint }>;
    getOrderBookPrices: (
      args: readonly [bigint],
    ) => Promise<readonly [readonly bigint[], readonly bigint[]]>;
  };
};

/** Absolute average entry from exact position (replaces removed getter). */
export async function getAverageEntryPrice(perps: PerpsReader, user: Address): Promise<bigint> {
  const position = await perps.read.getUserPosition([user]);
  if (position.netQuantity === 0n) return 0n;
  const absQty = position.netQuantity < 0n ? -position.netQuantity : position.netQuantity;
  const absEntry = position.netEntryValue < 0n ? -position.netEntryValue : position.netEntryValue;
  return (absEntry * 1_000_000n) / absQty;
}

export async function getBestBidPrice(perps: PerpsReader): Promise<bigint> {
  const [bids] = await perps.read.getOrderBookPrices([1n]);
  return bids[0] ?? 0n;
}

export async function getBestAskPrice(perps: PerpsReader): Promise<bigint> {
  const [, asks] = await perps.read.getOrderBookPrices([1n]);
  return asks[0] ?? 0n;
}
