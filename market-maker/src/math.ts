export const QUANTITY_DECIMALS = 6;
export const QUANTITY_SCALE = 10n ** BigInt(QUANTITY_DECIMALS);
export const BPS_SCALE = 10_000n;

/** Round price DOWN to nearest tick (for bids). */
export function roundDownToTick(price: bigint, tick: bigint): bigint {
  return (price / tick) * tick;
}

/** Round price UP to nearest tick (for asks). */
export function roundUpToTick(price: bigint, tick: bigint): bigint {
  const remainder = price % tick;
  return remainder === 0n ? price : price + tick - remainder;
}

/** Notional value: price * absQuantity / 10^QUANTITY_DECIMALS. */
export function calculateNotional(price: bigint, absQuantity: bigint): bigint {
  return (price * absQuantity) / QUANTITY_SCALE;
}

/** Apply basis-point offset to a price: price * (BPS_SCALE +/- bps) / BPS_SCALE. */
export function applyBps(price: bigint, bps: bigint): bigint {
  return (price * (BPS_SCALE + bps)) / BPS_SCALE;
}

/**
 * Rolling window statistics for realized volatility.
 * Stores raw price samples and computes std-dev of log-returns.
 */
export class RollingWindow {
  private readonly samples: number[];
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
    this.samples = [];
  }

  push(value: number): void {
    this.samples.push(value);
    if (this.samples.length > this.maxSize) {
      this.samples.shift();
    }
  }

  get length(): number {
    return this.samples.length;
  }

  /** Compute realized volatility as std-dev of log-returns (annualized not needed here). */
  volatility(): number {
    if (this.samples.length < 3) return 0;

    const logReturns: number[] = [];
    for (let i = 1; i < this.samples.length; i++) {
      const prev = this.samples[i - 1];
      const curr = this.samples[i];
      if (prev > 0 && curr > 0) {
        logReturns.push(Math.log(curr / prev));
      }
    }

    if (logReturns.length < 2) return 0;

    const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
    const variance =
      logReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (logReturns.length - 1);
    return Math.sqrt(variance);
  }

  /** Median of samples (for gas spike detection). */
  median(): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  latest(): number | undefined {
    return this.samples.length > 0 ? this.samples[this.samples.length - 1] : undefined;
  }
}

/**
 * Rolling budget tracker: sums amounts in a sliding time window.
 * Used for gas budget enforcement (hourly / daily).
 */
export class RollingBudget {
  private readonly entries: Array<{ timestamp: number; amount: bigint }> = [];
  private readonly windowMs: number;

  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  add(amount: bigint): void {
    this.entries.push({ timestamp: Date.now(), amount });
  }

  total(): bigint {
    this.prune();
    let sum = 0n;
    for (const e of this.entries) {
      sum += e.amount;
    }
    return sum;
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    while (this.entries.length > 0 && this.entries[0].timestamp < cutoff) {
      this.entries.shift();
    }
  }
}

/** Absolute value for bigint. */
export function bigAbs(v: bigint): bigint {
  return v < 0n ? -v : v;
}
