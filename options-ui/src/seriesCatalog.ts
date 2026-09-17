import { formatUnits, parseUnits } from "viem";

export type SeriesMeta = {
  seriesId: bigint;
  strikeE8: bigint;
  expiryTs: bigint;
  isCall: boolean;
  tickSizeE8: number;
  lotSize: number;
  status: number;
};

export type ChainRow = {
  key: string;
  expiryTs: bigint;
  strikeE8: bigint;
  callSeriesId: bigint | null;
  putSeriesId: bigint | null;
};

export const STATUS_LABELS = ["Inactive", "Active", "Frozen", "Settled"] as const;

export function statusLabel(status: number): string {
  return STATUS_LABELS[status] ?? "?";
}

export function formatStrikeUsd(strikeE8: bigint): string {
  return `$${formatUnits(strikeE8, 8)}`;
}

/**
 * Premium in USDC for display. On-chain: premium (1e8 fixed) = priceTicks × tickSizeE8.
 */
export function premiumFromTicks(priceTicks: bigint, tickSizeE8: number): string {
  if (tickSizeE8 === 0) return "0";
  const premiumE8 = priceTicks * BigInt(tickSizeE8);
  return formatUnits(premiumE8, 8);
}

/**
 * Parse a decimal USDC premium string to price ticks. Returns null if not a multiple of tick size.
 */
export function priceTicksFromPremiumInput(premiumDecimal: string, tickSizeE8: number): bigint | null {
  if (tickSizeE8 === 0) return null;
  const trimmed = premiumDecimal.trim();
  if (trimmed === "") return null;
  let premiumE8: bigint;
  try {
    premiumE8 = parseUnits(trimmed, 8);
  } catch {
    return null;
  }
  if (premiumE8 === 0n) return null;
  const ts = BigInt(tickSizeE8);
  if (premiumE8 % ts !== 0n) return null;
  return premiumE8 / ts;
}

export function midPremiumE8(
  bidTick: bigint,
  askTick: bigint,
  tickSizeE8: number,
): string | null {
  if (bidTick === 0n || askTick === 0n) return null;
  const mid = (bidTick + askTick) / 2n;
  return premiumFromTicks(mid, tickSizeE8);
}

export function buildChainRows(catalog: SeriesMeta[]): ChainRow[] {
  const map = new Map<
    string,
    { expiryTs: bigint; strikeE8: bigint; call: bigint | null; put: bigint | null }
  >();
  for (const s of catalog) {
    const key = `${s.expiryTs.toString()}-${s.strikeE8.toString()}`;
    let row = map.get(key);
    if (!row) {
      row = { expiryTs: s.expiryTs, strikeE8: s.strikeE8, call: null, put: null };
      map.set(key, row);
    }
    if (s.isCall) {
      row.call = s.seriesId;
    } else {
      row.put = s.seriesId;
    }
  }
  return [...map.values()]
    .map((r) => ({
      key: `${r.expiryTs.toString()}-${r.strikeE8.toString()}`,
      expiryTs: r.expiryTs,
      strikeE8: r.strikeE8,
      callSeriesId: r.call,
      putSeriesId: r.put,
    }))
    .sort((a, b) => {
      if (a.expiryTs !== b.expiryTs) {
        return a.expiryTs < b.expiryTs ? -1 : 1;
      }
      if (a.strikeE8 !== b.strikeE8) {
        return a.strikeE8 < b.strikeE8 ? -1 : 1;
      }
      return 0;
    });
}

export function uniqueExpiriesSorted(chainRows: ChainRow[]): bigint[] {
  const set = new Set<string>();
  const out: bigint[] = [];
  for (const r of chainRows) {
    const k = r.expiryTs.toString();
    if (!set.has(k)) {
      set.add(k);
      out.push(r.expiryTs);
    }
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
