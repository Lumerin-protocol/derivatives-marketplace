# TODO

## Connect trades with orders via `makerOrderId`

- [ ] Add `bytes32 indexed makerOrderId` to the `PositionTrade` event
- [ ] Thread `makerOrderId` from `_executeMatch` → `_createPosition` → `_updateUserPosition` → `_settleOpposite`
- [ ] Remove derivable fields from the event to fix "stack too deep":
  - `netQuantityAfter` — the indexer tracks `user.netQuantity` and computes this itself
  - `aggregatedEntryPriceAfter` — the indexer computes weighted average entry prices from its own state
- [ ] Update indexer schema: add `order: Order` to `Trade`
- [ ] Update subgraph manifest with new `PositionTrade` event signature
- [ ] Update indexer handler to derive `netQuantityAfter` and `aggregatedEntryPriceAfter` from state
- [ ] Update indexer tests

Target event signature:

```solidity
event PositionTrade(
    address indexed user,
    bytes32 indexed makerOrderId,
    uint256 tradePrice,
    int256 quantity,
    int256 realizedPnl,
    int256 tradingFee
);
```

## Dynamic market exposure limits

Limit per-user position size and scale maintenance margin dynamically as notional exposure grows — inspired by [Aster's tiered system](https://www.asterdex.com/en/futures/trading-rules/leverage-and-margin), but using a continuous curve instead of rigid brackets.

### Continuous margin curve

Instead of discrete tiers, compute maintenance margin rate as a continuous function of notional exposure. Candidate formulas (pick one):

```
MMR(N) = mmr₀ + k · ln(1 + α·N)          — logarithmic (sub-linear growth, gentle on mid-size)
MMR(N) = mmr₀ + mmrScale · N / (N + k)    — hyperbolic  (bounded ceiling, simple fixed-point math)
MMR(N) = mmr₀ + k · N                     — linear      (simplest, but no ceiling)
```

Max leverage follows directly: `maxLeverage(N) = 1 / MMR(N)`.

Parameters (`mmr₀`, `k`, `α` or `mmrScale`) are admin-tunable per market. This avoids cliff edges between tiers and lets small traders keep high leverage while whales face progressively tighter requirements.

### Insurance-fund-derived cap

Tie the per-user notional cap to the insurance fund so limits grow automatically as the fund accrues fees:

```
maxNotional(leverage) = insuranceFundBalance × coverageRatio / MMR(leverage)
```

- `coverageRatio` — safety factor (e.g. 0.1 → no single user can claim more than 10% of the fund in one liquidation event)
- As the insurance fund grows from collected trading/liquidation fees, allowable position sizes expand without manual re-bracketing

### Orderbook-depth-derived margin (future / off-chain)

The real constraint on safe liquidation is how much notional can be closed without excessive slippage:

```
MMR(N) = N / slippageAdjustedDepth
```

This is adaptive to real-time market conditions but hard to do fully on-chain (oracle/manipulation risk). Could be implemented as a keeper-side pre-check or fed on-chain via a trusted depth oracle in a later phase.

### Oracle-settled liquidation and the depth caveat

When liquidations settle at oracle/mark price rather than executing against the orderbook, local book depth becomes irrelevant to the liquidation mechanic itself — there's no market order to fill. However, two deeper issues remain:

**Counterparty funding gap.** Every liquidated long has a short counterparty who eventually wants to withdraw real funds. If the losing side's margin doesn't fully cover the PnL, the insurance fund tops it up. The fund's capital comes from fees collected on real orderbook trades, so sustained thin markets → slow fund growth → lower capacity to absorb losses. This ties back to the insurance-fund-derived cap above.

**Oracle manipulation.** If the reference market (spot or external perp) is thin, an attacker can:

1. Open a large position on our platform
2. Temporarily manipulate the reference market price
3. Trigger favorable liquidation / settlement at the manipulated mark price

Deeper reference markets make this attack prohibitively expensive. So **depth of the oracle source** still matters enormously — just not for the liquidation execution path.

- [ ] Evaluate oracle source depth: document minimum reference-market depth required per listed asset
- [ ] Consider TWAP or median-of-N-sources oracle to raise manipulation cost
- [ ] Add circuit breaker: pause liquidations if mark price deviates from TWAP beyond a threshold
- [ ] Stress-test insurance fund sustainability under thin-market scenarios

### Tasks

**Core curve (on-chain)**

- [ ] Add per-market config struct: `mmr0`, `k`, `alpha` (or `mmrScale`), `coverageRatio` — admin-settable
- [ ] Implement `_maintenanceMarginRate(notional)` pure function (start with hyperbolic or log curve)
- [ ] Derive `_maxLeverage(notional)` as `1 / MMR`
- [ ] On order placement / match, enforce effective leverage ≤ `_maxLeverage(resultingNotional)`
- [ ] Use `_maintenanceMarginRate(notional)` in liquidation health checks

**Insurance fund cap (on-chain)**

- [ ] Implement `_maxNotional(leverage)` using insurance fund balance and `coverageRatio`
- [ ] Enforce the cap alongside the leverage check on order placement
- [ ] Decide whether to read fund balance live or snapshot it periodically (gas vs. staleness trade-off)

**Orderbook depth (off-chain / future)**

- [ ] Add keeper-side pre-check: reject orders that would create positions exceeding slippage-safe depth
- [ ] Explore trusted depth oracle for on-chain enforcement in a later phase

**Testing & validation**

- [ ] Contract tests covering small, medium, and whale-sized positions across the curve
- [ ] Test that notional cap scales correctly as insurance fund balance changes
- [ ] Gas-benchmark the curve math to keep it cheap

---

## Decision: keep oracle-settled liquidation (no orderbook matching)

Liquidations currently settle at Chainlink oracle price in a single atomic transaction. We considered rewriting to match against resting orderbook orders first, but decided against it for now.

### Why not orderbook-first liquidation

- **Empty book fallback.** If no resting orders exist at the liquidation price, we'd need a fallback path (oracle settlement or ADL) anyway — meaning we'd build everything we have now _plus_ the orderbook path.
- **Slippage creates more bad debt.** A large liquidation eating through a thin book gets worse execution than oracle price, potentially increasing bad debt rather than reducing it.
- **Gas.** Oracle settlement is one SLOAD + arithmetic. Orderbook matching is a loop through price levels with storage writes per fill.
- **MEV.** Liquidation orders on the book are sandwichable. Oracle settlement is atomic with no intermediate state to exploit.
- **The real risk is oracle quality, not execution path.** Better addressed by TWAP, multi-source oracles, and circuit breakers (see above).

### Revisit when

- Book depth is consistently deep enough to absorb liquidations without significant slippage
- Reserve pool is taking noticeable hits from the gap between oracle price and where a real fill would have landed
- Partial liquidation is implemented (reduce to safe tier rather than full close) — pairs naturally with orderbook matching

---

## Oracle hardening against manipulation

With oracle-settled liquidation, the price feed is the single point of trust. The oracle decides _who_ gets liquidated — the execution path is downstream. If an attacker can briefly spike the oracle, they can force a wrongful liquidation regardless of how the position is closed. Defenses must protect the trigger, not the settlement.

### TWAP oracle

Maintain an on-chain time-weighted average price over a configurable window (e.g. 5 minutes). Use the TWAP — not the spot oracle — for liquidation health checks. The attacker now needs to sustain price manipulation across the entire window rather than a single block, raising attack cost by orders of magnitude.

Implementation ideas:

- Store a ring buffer of `(price, timestamp)` observations; update on every trade or on a heartbeat call
- Compute TWAP on read: `Σ(priceᵢ × Δtᵢ) / Σ(Δtᵢ)` over the window
- Alternatively, use a cumulative price accumulator (Uniswap V2 style): store `cumulativePrice += price × elapsed` on each update, then `TWAP = (cumulativeNow − cumulativeThen) / (tNow − tThen)`
- The accumulator approach is cheaper (one SSTORE per update, two SLOADs per read) but requires at least one observation older than the window

### Circuit breaker

Pause liquidations when the spot oracle deviates from the TWAP beyond a threshold. This catches flash crashes, oracle lag, and manipulation attempts that are too fast for TWAP alone to fully smooth out.

Implementation ideas:

- On every `liquidate()` call, compute `deviation = |spotPrice − twap| / twap`
- If `deviation > circuitBreakerThreshold` (e.g. 5%), revert with `PriceDeviationTooHigh`
- Admin-configurable threshold per market (volatile assets get a wider band)
- Optional cooldown: after a circuit breaker triggers, require N blocks or M seconds before liquidations can resume, even if price returns to normal — prevents rapid on/off toggling

### Multi-source median oracle (future)

Use the median of N independent price sources instead of a single Chainlink feed. The attacker must manipulate ⌈N/2⌉ + 1 independent markets simultaneously.

Implementation ideas:

- Accept prices from multiple Chainlink feeds, Pyth, Redstone, or an internal VWAP from our own orderbook
- Compute on-chain median (sort N values, take middle) — feasible for small N (3–5 sources, ~2k gas for sorting)
- Staleness check per source: exclude any feed older than a configurable max age
- Fallback: if fewer than a quorum of sources are fresh, pause trading or fall back to TWAP-only mode

### Tasks

- [ ] Implement cumulative price accumulator; update on each trade and/or keeper heartbeat
- [ ] Add `_getTwap(windowSeconds)` view function
- [ ] Switch `isLiquidatable` to use TWAP instead of spot oracle price
- [ ] Add circuit breaker: revert `liquidate()` when spot-vs-TWAP deviation exceeds threshold
- [ ] Make TWAP window and circuit breaker threshold admin-configurable per market
- [ ] Evaluate additional oracle sources (Pyth, Redstone) for future median oracle
- [ ] Add contract tests: simulate price spikes and verify liquidations are blocked
- [ ] Add contract tests: verify TWAP converges correctly under normal price movement

Discover AMM:
https://github.com/RohanShrothrium?tab=repositories
https://github.com/RohanShrothrium/amm-challenge
https://hackmd.io/@0xtrojan

https://github.com/myx-protocol/myx-contracts/blob/main/contracts/periphery/MultipleTransfer.sol

https://app.myx.finance/trade/BTCUSDT
