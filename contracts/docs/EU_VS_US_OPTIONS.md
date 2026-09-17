# European vs American Options On-Chain

## Industry Standard

Nearly every on-chain options protocol uses **European-style** (exercise at expiry only):

| Protocol                 | Style    | Model                               | Status                |
| ------------------------ | -------- | ----------------------------------- | --------------------- |
| Lyra -> Derive           | European | AMM + Black-Scholes                 | OK, european          |
| Aevo                     | European | Off-chain CLOB, on-chain settlement | ok, european          |
| Opyn / Squeeth           | European | Power perps                         |                       |
| Dopex                    | European | Single-staking vaults               | Renamed to Stryke.xyz |
| Premia v3                | European | AMM with concentrated liquidity     | OK, european          |
| PsyOptions (Solana)      | European | CLOB                                | n/a, european         |
| Deribit (CeFi reference) | European | CLOB                                |

**Hegic** is a notable exception — American-style, but peer-to-pool AMM with no order book and no assignment problem.

### Why European Dominates

1. **Closed-form pricing** — Black-Scholes / Black-76 gives an exact answer. American options have no closed-form solution (require binomial trees, finite difference methods, or least-squares Monte Carlo — all prohibitively expensive on-chain).
2. **Settlement is a single event** — a keeper calls `settleExpiry()` once, reads the oracle, batch-settles all positions.
3. **No assignment problem** — with American exercise, when a long exercises you must pick _which_ short gets assigned. That's a hard fairness/gas problem on-chain.

## American Options: What They Require

### Key Insight for Options on Perps

For **American calls on futures**, early exercise is **never optimal** when cash-settled. Exercising early captures intrinsic value but destroys time value. Since futures have no dividends or carry costs, there's no incentive — a rational holder always sells the option instead.

For **American puts on futures**, early exercise **can** be optimal when the put is deep ITM — the interest earned on receiving cash now can exceed the remaining time value.

In practice: American calls on perps behave identically to European calls. Only puts gain the early exercise right.

### Implementation Requirements

**Early exercise function** (~80 lines) — any long holder can exercise at any time, computing intrinsic value at current oracle price.

**Assignment problem** (~150 lines, hardest part) — selecting which short is assigned when a long exercises:

| Method                    | Fairness                             | Gas                        | Notes                                  |
| ------------------------- | ------------------------------------ | -------------------------- | -------------------------------------- |
| FIFO (oldest short first) | Predictable, penalizes early writers | O(1) amortized             | Needs position queue per series        |
| Pro-rata (proportional)   | Fair                                 | O(n), n = number of shorts | Expensive with many shorts             |
| Random (VRF)              | Fair in expectation                  | O(1) + VRF callback        | Async settlement, Chainlink dependency |

**Higher margin** (~30 lines) — shorts must cover full intrinsic value at all times: `IM = max(stress_worst_case, current_intrinsic + buffer)`.

**Pricing** — either accept Black-76 as approximation (~0 new lines) or implement Barone-Adesi-Whaley quadratic approximation (~200 lines of fixed-point math).

**Liquidation interaction** (~50 lines) — exercise must take priority over liquidation since the long has a contractual right.

**Testing** (~500+ lines) — exercise at various moneyness levels, assignment correctness, margin adequacy during exercise, race conditions (exercise + liquidation, exercise + expiry).

**Total estimate: ~500–1000 lines** on top of the European base, plus permanently higher margin requirements that discourage market makers.

## The Liquidity Problem with European Options

The strongest argument for American options: **what if there's no liquidity to sell a European option early?**

You're long a call, strike 50k, current price 70k. Intrinsic = 20k. But the order book has no bids (or bids at a steep discount). Expiry is 25 days away. Your 20k of value is trapped.

This is worst for:

- **Deep ITM options** — MMs don't like quoting these (spread is tiny vs premium, capital-intensive)
- **Long-dated options** — more time locked, more price risk
- **New/thin markets** — few participants, wide spreads
- **Volatile periods** — exactly when you want to exit, MMs pull quotes

## Middle-Ground Solutions

### 1. Short Expiry Cycles Only

Offer only weeklies (or dailies). Maximum trapped time is 7 days. Most on-chain protocols do this. Tradeoff: no long-dated hedging.

### 2. Market Maker Obligations

Registered MMs must maintain two-sided quotes within some maximum spread. Incentivized with fee rebates, penalized by revoking MM status. Cannot be enforced absolutely — an MM can always stop.

### 3. Exercise-Settle Hybrid (Recommended)

European semantics for normal usage, plus a last-resort escape hatch for trapped deep ITM positions:

```solidity
function earlySettle(bytes32 seriesHash, int128 quantity) external {
    // Only for deep ITM options (intrinsic > 20% of strike)
    // Only for longs, only before expiry
    // Penalty: long receives (intrinsic - earlySettleFee) instead of full intrinsic
    // Fee (1-2%) compensates shorts for the disruption
    // Assignment: pro-rata across ALL shorts in the series
    // Long's position closed, shorts' positions reduced proportionally
}
```

**Why this works:**

- **No assignment problem** — pro-rata across all shorts; no single short singled out. Gas is manageable because it's a rare operation.
- **Fee discourages abuse** — 1-2% fee means it's only used when the book truly has no liquidity. If a bid exists at 98% of intrinsic, selling on the book is better.
- **Deep ITM threshold prevents gaming** — can't early-settle ATM/OTM options, preventing circumvention of European semantics for speculative timing.
- **Shorts know the rules upfront** — pro-rata risk is predictable and priced into quotes.

**Implementation cost:**

| Component                     | Lines    |
| ----------------------------- | -------- |
| `earlySettle` function        | ~80      |
| Pro-rata assignment loop      | ~60      |
| Margin adjustment post-settle | ~30      |
| Events + views                | ~20      |
| Tests                         | ~200     |
| **Total**                     | **~390** |

### 4. Mutual Early Settlement

Long and short agree to settle early — fully consensual, zero fairness issues:

```solidity
function proposeEarlySettle(bytes32 seriesHash, int128 quantity, uint256 price) external;
function acceptEarlySettle(uint256 proposalId) external;
```

Simplest approach but depends on a willing counterparty, which is the same liquidity problem.

## Recommendation

**European + exercise-settle hybrid** for v1:

- Clean European semantics for 99% of usage (pricing, margin, settlement all use Black-76 as-is)
- Escape hatch for the "trapped deep ITM with no liquidity" scenario
- Fee structure makes it self-regulating (only used when truly needed)
- Pro-rata assignment is fair and predictable for shorts
- Modest implementation cost (~390 lines on top of European base)

Alternative: launch pure European with weekly expiries and add the hybrid later if liquidity proves problematic. The upgrade path is clean — `earlySettle` is purely additive, no existing logic changes.
