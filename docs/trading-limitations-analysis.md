# Trading Limitations Analysis: Titan Contracts

**Date**: 2026-07-29  
**Contracts analyzed**: `perps` (HashPowerPerpsDEX), `futures-marketplace` (Futures), `perps` (Options subsystem)

---

## 1. Latency (Blockchain Block Time)

| Parameter | Value | Source |
|-----------|-------|--------|
| Block time | ~12 seconds | Standard Arbitrum/Ethereum L2 block cadence |
| Oracle staleness | `MAX_ORACLE_STALENESS = 3600` s (1 hour) | `HashPowerPerpsDEX.sol:39`, `Futures.sol:102` |

**Implication**: The effective minimum latency for responding to price changes is one block (~12s). A 1-hour oracle staleness window means the system can tolerate up to an hour without fresh oracle data before reverting trades. Post-staleness, all `getMarketPrice()` calls revert with `OracleStale`.

---

## 2. Maximum Order Book Updates Per Latency Interval

There is **no hardcoded limit** on how many orders can be matched within a single transaction. The practical limit is **gas**.

### Perps (HashPowerPerpsDEX) — Measured Gas Benchmarks

| Scenario | Gas Used | Avg per Match |
|----------|----------|---------------|
| Resting only (0 matches) | 456,016 | — |
| 1 match | 421,477 | 421,477 |
| 3 matches, 1 level | 455,430 | 151,810 |
| 10 matches, 1 level | 777,240 | 77,724 |
| 10 matches, 5 levels | 853,343 | 85,334 |
| 20 matches, 1 level | 1,236,345 | 61,817 |
| 20 matches, 10 levels | 1,407,576 | 70,379 |
| 32 matches, 1 level | 1,787,272 | 55,852 |

**Practical bounds** (assuming ~30M gas block limit on Arbitrum):
- **~500 matches** per transaction at a single price level (~55k gas/match marginal)
- **~400 matches** across multiple price levels (~70k gas/match marginal)

These are empirical bounds from the on-chain matching loop (`_matchOrdersAtPrice`). The marginal cost per additional match drops as the fixed overhead (funding settlement, IV update, margin check) is amortized.

### Futures — Same pattern

Futures uses the same `StructuredLinkedList`-based FIFO walk in `_matchOrdersAtPrice`. Similar gas scaling applies, allowing hundreds of matches per block.

### Options (OptionOrderBook)

Options use a **tick-bitmap + FIFO queue** structure (adapted from Uniswap v3). The matching loop in `OptionMatchingRouter._match()` walks price levels via `nextLevel()` and dequeues orders at each level via `bestAsk()`/`bestBid()`. Each match triggers:
- `book.fillOrder()` (O(1) linked-list update)
- `_settleFill()` (premium transfer + position update)
- IV update (once per submission, not per match)

Estimated **~300-400 matches per tx** (similar gas profile, slightly cheaper per match since no funding settlement).

---

## 3. Maximum Matches Within a Single Transaction

| Contract | Hard Limit | Effective Limit |
|----------|-----------|-----------------|
| Perps | None | ~500 matches @ ~30M gas |
| Futures | None | ~500 matches @ ~30M gas |
| Options | None | ~400 matches @ ~30M gas |

Key constraints within the matching loop:
- **Self-cross prevention**: Maker orders from the same address as the taker are netted out without fees/events (STP semantics).
- **No re-entrancy risk**: Both contracts use `_msgSender()` checks and isolated internal transfers.
- **Gas griefing**: A taker could be matched against many tiny maker orders, but the maker pays no gas (they are passive). The taker bears the gas cost — a natural economic disincentive for spamming tiny orders.

---

## 4. Active Price Levels

| Contract | Max Active Price Levels Per Side | Source |
|----------|-------------------------------|--------|
| Perps | **200** (bids) + **200** (asks) = 400 total | `HashPowerPerpsDEX.sol:43` — `MAX_PRICE_LEVELS_PER_SIDE = 200` |
| Futures | **200** (bids) + **200** (asks) **per expiration date** | `Futures.sol:100` — `MAX_PRICE_LEVELS_PER_SIDE = 200` |
| Options | **Unlimited** (bitmap-based, practical ceiling is `type(uint64).max` ticks) | `TickBitmapLib.sol` — 256 ticks/word, unbounded words |

**Details**:
- Perps uses `StructuredLinkedList` for sorted bid/ask prices. When a new price level would exceed 200, `MaxPriceLevelsReached` reverts.
- Futures has the same limit **per expiration date**. With `futureExpirationDatesCount = 10`, the theoretical max across all expiries is `10 × 200 × 2 = 4000` levels.
- Options uses a **bitmap** (`uint64 → 256 bits/word`), meaning up to `2^64` distinct tick levels are theoretically addressable. In practice, gas costs for bitmap scanning bound the usable range.

**Test verification** (`orderBookLimits.test.ts`):
- Confirmed cap is enforced at 200.
- Existing levels can still receive new orders (orders queue at the same price).
- Cancelling an order at a level frees a slot.
- Cap is independent per side (bids vs asks).

---

## 5. Price Granularity

| Contract | Minimum Increment | Precision | Source |
|----------|-------------------|-----------|--------|
| Perps | `minimumPriceIncrement` (immutable, set at deploy) | e.g., `$0.01` (1e4 in token units) | `HashPowerPerpsDEX.sol:44`, `:1173-1179` |
| Futures | `minimumPriceIncrement` (set at `initialize`) | e.g., `$0.01` (1e4 in USDC units) | `Futures.sol:41`, `validatePrice()` check |
| Options | `tickSizeE8` per series (set by admin at series creation) | e.g., 0.01 USD in 1e8 = 1,000,000 ticks | `OptionMarketRegistry.sol:25`, `:93` |

All prices must be multiples of the minimum increment. Non-multiple prices revert with `InvalidPrice`.

**Perps**: `minimumPriceIncrement` is **immutable** — changing it requires contract migration.  
**Futures**: `minimumPriceIncrement` is mutable via admin (setter exists).  
**Options**: `tickSizeE8` is per-series, immutable once the series is created.

---

## 6. Minimal Price

| Contract | Min Price | Source |
|----------|-----------|--------|
| Perps | `minimumPriceIncrement` (price cannot be 0) | `_validatePrice()` reverts on `price == 0` or non-multiple |
| Futures | `minimumPriceIncrement` (price cannot be 0) | `validatePrice()` reverts on `price == 0` or non-multiple |
| Options | `tickSizeE8` (priceTicks cannot be 0) | `placeOrder()` reverts with `InvalidPrice()` if `priceTicks == 0` |

The minimum valid order price is one increment above zero.

---

## 7. Liquidation

### 7.1 Margin Model

All three subsystems delegate margin computation to a shared **PortfolioMarginEngine** (PME):

| Parameter | Perps | Futures | Options |
|-----------|-------|---------|---------|
| Initial Margin (IM) shock | 10% (`marginPercent`) | Configurable (`liquidationMarginPercent`, test: 20%) | 15% spot + 10 vol pts |
| Maintenance Margin (MM) shock | 5% (`maintenanceMarginPercent`) | Configurable (`liquidationMarginPercent`, test: 20%) | 10% spot + 5 vol pts |
| Underwater check | `balance < portfolioMargin.computePortfolioMM()` | Same | Same |
| Cross-product margin | Yes (PME aggregates perps + futures + options) | Yes | Yes |

### 7.2 Perps Liquidation

| Feature | Detail | Source |
|---------|--------|--------|
| Trigger | `balanceOf(user) < portfolioMargin.computePortfolioMM(user)` | `:879-884` |
| Order liquidation | `liquidateOrder(user, orderId)` — permissionless, cancels a single resting order | `:973-982` |
| Batch order liquidation | `liquidateOrders(user, orderIds[])` — cancels multiple orders, stops when healthy | `:986-1001` |
| Position liquidation | `liquidatePosition(user, closeQty)` — **orders must be cleared first** (`OrdersStillOpen` guard) | `:914-946` |
| Partial liquidation | Supported. `closeQty < \|netQuantity\|`. Guards against over-liquidation (`OverLiquidation`) | `:934-940` |
| Keeper fee | **DISABLED** (0 fee emitted). Variable + event field reserved for future incentive. | `:942-945`, `:1006-1016` |
| Bad debt | User loss > collateral → insurance fund covers up to its balance. Shortfall emits `BadDebt`. | `:1028-1037` |
| Batch (multi-user) | No on-chain entry point; keeper processes and re-snapshots each user independently | Keeper venue adapter |

**Critical invariant**: Orders MUST be liquidated before the position. Keepers sequence:
```
liquidateOrders(user, orderIds)
re-snapshot portfolio health
liquidatePosition(user, closeQty)
```

### 7.3 Futures Liquidation

| Feature | Detail | Source |
|---------|--------|--------|
| Trigger | `collateralVault.balanceOf(user) < marginEngine.computePortfolioMM(user)` | `:866-875` |
| Order liquidation | `liquidateOrder(user, orderId)` — permissionless | `:879-885` |
| Batch order liquidation | `liquidateOrders(user, orderIds[])` | `:889-902` |
| Position liquidation | `liquidatePosition(user, expirationAt, closeQty)` — orders-first | `:917-927` |
| Batch position liquidation | `liquidatePositions(user, expirationAts[], closeQtys[])` | `:931-951` |
| Partial liquidation | Supported with `OverLiquidation` guard | `:954-978` |
| Keeper fee | **DISABLED** (0) | `:904-909`, `:968-969` |
| Bad debt | PnL shortfall → `BadDebt` event | `:993` |
| Settlement | Cash-settled at expiry via `settlePosition()` (pinned settlement price) | `:1033-1049` |

### 7.4 Options Liquidation

| Feature | Detail | Source |
|---------|--------|--------|
| Trigger | `!isHealthy(account)` → `vault.balanceOf(user) < portfolioMargin.computePortfolioMM(user)` | `:276-278` |
| What's liquidated | **Short positions only** (`netQuantity < 0`). Longs need no ongoing margin. | `:280-281` |
| Liquidator takes on | The liquidator assumes the short position at market price | `:296-297` |
| Fee | `marginForLiquidated × liquidationFeeBps / 10_000` (% of margin freed), paid from liquidated user to liquidator | `:286-293` |
| Health check | Uses stress-scenario margin: spot shock + vol shock applied to Black-76 Greeks | `:586-612` |
| Not short position | Reverts `NotShortPosition` — longs cannot be liquidated | `:281` |

---

## 8. Additional Constraints Summary

### 8.1 Order Limits Per Participant

| Contract | Max Orders | Source |
|----------|-----------|--------|
| Perps | **100** | `MAX_ORDERS_PER_PARTICIPANT = 100` |
| Futures | **100** | `MAX_ORDERS_PER_PARTICIPANT = 100` |
| Options | Unlimited (but max 20 active series) | `maxSeriesPerUser = 20` |

### 8.2 Deprecated Minimum Order Margin (Perps only)

`minimumMarginPerOrder`, its setter/event, and `OrderMarginTooLow` remain in the ABI for compatibility, but no order path enforces the value. Portfolio IM from the PME is the canonical collateral requirement.

### 8.3 Time-in-Force Options

All three venues support:
- **GTC** (Good-Till-Cancelled): Match then rest remainder.
- **IOC** (Immediate-Or-Cancel): Match only, cancel rest. Reverts if zero fills.
- **FOK** (Fill-Or-Kill): Full fill or revert.

Options additionally supports **PostOnly** (revert if would match immediately).

### 8.4 Contract Size

Both perps and futures use `CONTRACT_SIZE_HPS_DAY = 1e15` (1 PH/s over a day). One contract = 1 PH/s/day. This aligns with the hashprice oracle quote basis.

### 8.5 Funding (Perps Only)

| Parameter | Value | Source |
|-----------|-------|--------|
| Decimals | `FUNDING_DECIMALS = 18` | `:41` |
| Max absolute rate | `fundingRateMaxBps` bps per `fundingPeriod` | `:88-89` |
| Default period | `fundingPeriod` (e.g., 86400 = 24h) | `:89` |
| Settlement | Per-user snapshot of `cumulativeFundingPerUnit` | `:90` |

### 8.6 Fees

| Venue | Maker Fee | Taker Fee | Liquidation Fee |
|-------|-----------|-----------|-----------------|
| Perps | 0 bps (0%) | 5 bps (0.05%) | $1 flat (test config) |
| Futures | $0/unit (test config) | $1/unit (test config) | Configurable flat |
| Options | 0 (no explicit fee — premium is the cost) | 0 | % of margin freed (`liquidationFeeBps`, e.g., 5%) |

### 8.7 Options-Specific Constraints

| Parameter | Value | Source |
|-----------|-------|--------|
| IV smoothing | EWMA α = 0.2 (20%) | `:162` |
| Max IV change per update | 500 bps (5% of current IV) | `:163` |
| Global IV bounds | [0.01, 5.0] in WAD (1% to 500%) | `:357-358` |
| Max series per user | 20 | `:160` |
| Settlement window | Configurable (e.g., 1800s = 30 min) | `:54` |
| Min observations for TWAP | Configurable (`minObservations`) | `:55` |
| Lot size | Per-series, set at creation | `OptionMarketRegistry:26` |

### 8.8 Oracle & Price Sources

All three use Chainlink-style `AggregatorV3Interface` oracles:
- **Perps**: `priceOracle` — hashprice (1 PH/s/day in collateral token units)
- **Futures**: `priceOracle` — hashprice USD feed
- **Options**: `oracle` — underlying spot price for Black-76 pricing

All enforce `MAX_ORACLE_STALENESS = 3600` (1 hour). Stale oracles revert reads (except the points hook's reference price, which gracefully returns 0).

---

## 9. Gas Benchmarks (Hardhat Local — Perps)

Run: `cd perps/contracts && npx hardhat --network hardhat test tests/gas-createOrder.test.ts`

```
createOrder_restingOnly (no match):         456,016 gas
createOrder_1Match:                         421,477 gas  (421,477 /match)
createOrder_3Matches_oneLevel:              455,430 gas  (151,810 /match)
createOrder_10Matches_oneLevel:             777,240 gas  ( 77,724 /match)
createOrder_10Matches_5Levels:              853,343 gas  ( 85,334 /match)
createOrder_20Matches_oneLevel:           1,236,345 gas  ( 61,817 /match)
createOrder_20Matches_10Levels:           1,407,576 gas  ( 70,379 /match)
createOrder_32Matches_oneLevel:           1,787,272 gas  ( 55,852 /match)
```

**Key insight**: The marginal gas per additional match drops to ~55k at scale, meaning **up to ~500 matches per 30M-gas block** are practical.

---

## 10. Summary Table

| Limitation | Perps | Futures | Options |
|------------|-------|---------|---------|
| **Latency** | ~12s block | ~12s block | ~12s block |
| **Oracle staleness** | 1 hour | 1 hour | 1 hour |
| **Max matches per tx** | ~500 (gas) | ~500 (gas) | ~400 (gas) |
| **Max price levels** | 200/side | 200/side/expiry | Unlimited (bitmap) |
| **Price granularity** | $0.01 (immutable) | $0.01 (configurable) | Per-series tick (1e8) |
| **Min price** | 1 increment | 1 increment | 1 tick |
| **Max orders/user** | 100 | 100 | Unlimited (20 series) |
| **Liquidation trigger** | balance < PME.MM | balance < PME.MM | balance < PME.MM |
| **Partial liquidation** | Yes (with guard) | Yes (with guard) | Yes (capped to position) |
| **Keeper fee** | Disabled (0) | Disabled (0) | % of margin freed |
| **Cross-margin** | Yes | Yes | Yes |
| **Funding** | Yes | No (expiry-based) | No (expiry-based) |
| **Settlement** | N/A (perpetual) | Cash TWAP at expiry | TWAP + intrinsic value |
