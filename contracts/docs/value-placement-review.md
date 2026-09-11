# HashPowerPerpsDEX.sol — Value Placement Review

All values categorized by storage mechanism and update path.

---

## 1. Bytecode Constants (`constant` keyword)

| Name | Value | Verdict | Notes |
|------|-------|---------|-------|
| `MAX_ORACLE_STALENESS` | `3600` | ✅ Correct | Private, protocol safety |
| `FUNDING_DECIMALS` | `18` | ✅ Correct | Precision standard. Changing it breaks all funding math |
| `QUANTITY_DECIMALS` | `6` | ✅ Correct | Precision standard. Changing it breaks all notional math |
| `CONTRACT_SIZE_HPS_DAY` | `1e15` | ✅ Correct | Fundamental economic unit |
| `VERSION` | `"3.0.0"` | ✅ Correct | Tied to bytecode |
| `MAX_ORDERS_PER_PARTICIPANT` | `100` | ✅ Correct | Architectural invariant |
| `MAX_PRICE_LEVELS_PER_SIDE` | `200` | ✅ Correct | Architectural invariant |

No changes needed. Already better than Futures — `minimumPriceIncrement` is correctly `immutable` here.

---

## 2. Immutable (constructor)

| Name | Source | Verdict |
|------|--------|---------|
| `minimumPriceIncrement` | Constructor arg | ✅ Correct. Tick size. Never changes. Would invalidate all orders if it did. |

One difference from Futures: `minimumPriceIncrement` is **already** immutable here. Futures should follow this pattern.

---

## 3. Proxy Storage — Set Once in `init`, No Setter

| Name | Set where | Notes |
|------|-----------|-------|
| `collateralToken` | `initialize` / `initializeV2` | Derived from vault. Public. Used in `_transferFee` and elsewhere. Fine as-is — derived from `vault`, so it changes if vault changes. |
| `tokenDecimals` | `initialize` | Private. Cached for gas. Could be recomputed on-the-fly from `collateralToken` but caching is fine. |
| `oracleDecimals` | `initialize` | Private. Cached for gas. Could be recomputed but fine. |
| `vault` | `initialize` / `initializeV2` | No setter. Changing the vault mid-lifecycle would orphan all collateral. Correctly locked down. |

All fine. No changes needed.

---

## 4. Proxy Storage — Mutable via Owner Transaction

| Name | Setter | Event | Safe live? |
|------|--------|-------|------------|
| `priceOracle` | `setOracle` | `OracleUpdated` | ✅ Yes |
| `liquidationFee` | `setLiquidationFee` | `LiquidationFeeUpdated` | ✅ Yes — flat minimum taker fee |
| `liquidationFeeBps` | `setLiquidationFeeBps` | `LiquidationFeeBpsUpdated` | ✅ Yes — only new liquidations |
| `liquidatorShareBps` | `setLiquidatorShareBps` | `LiquidatorShareBpsUpdated` | ✅ Yes |
| `takerFeeBps` / `makerFeeBps` | `setMatchFee` | `MatchFeeUpdated` | ✅ Yes — only new matches |
| `fundingRateMaxBps` / `fundingPeriod` | `setFundingParameters` | `FundingParametersUpdated` | ✅ Yes — only future funding accrual |
| `minimumMarginPerOrder` | `setMinimumMarginPerOrder` | `MinimumMarginPerOrderUpdated` | Compatibility only — stored and emitted, never enforced |
| `portfolioMargin` | `setPortfolioMargin` | `PortfolioMarginUpdated` | ⚠️ Instant re-evaluation of all positions |
| `hook` | `setHook` | `HookUpdated` | ✅ Yes |

All setters now emit events. Previously `setOracle` and `setPortfolioMargin` were silent.

---

## 5. 🟢 Dead Storage — Removed

| Name | Declared | Written | Read | Events exist? |
|------|----------|---------|------|---------------|
| `marginPercent` | ✅ L55 | ❌ Never | ❌ Never | ✅ `MarginPercentUpdated` |
| `maintenanceMarginPercent` | ✅ L56 | ❌ Never | ❌ Never | ✅ `MaintenanceMarginPercentUpdated` |

These are **remnants from before the PME integration**. The contract used to compute margin internally with these percentages. Now all margin is delegated to `portfolioMargin.computePortfolioIM/MM()`. The variables and their events are dead code.

They were replaced with gap slots; participant reset no longer emits unrelated
configuration events.

---

## 5. 🟢 Dead Storage — Removed

`marginPercent` and `maintenanceMarginPercent` were dead (never written, never read). Replaced with `_gapMarginPercent` and `_gapMaintenanceMarginPercent` to preserve the UUPS storage layout. Their events (`MarginPercentUpdated`, `MaintenanceMarginPercentUpdated`) were also removed.

## 6. Events — Now Complete

All config setters now emit events:

| Setter | Event |
|--------|-------|
| `setOracle` | `OracleUpdated` |
| `setPortfolioMargin` | `PortfolioMarginUpdated` |
| `setLiquidationFee` | `LiquidationFeeUpdated` |
| `setLiquidationFeeBps` | `LiquidationFeeBpsUpdated` |
| `setLiquidatorShareBps` | `LiquidatorShareBpsUpdated` |
| `setMatchFee` | `MatchFeeUpdated` |
| `setMinimumMarginPerOrder` | `MinimumMarginPerOrderUpdated` |
| `setFundingParameters` | `FundingParametersUpdated` |
| `setHook` | `HookUpdated` |

## 7. Internal / Operational State

| Name | Notes |
|------|-------|
| `nonce` | Order ID counter |
| `cumulativeFundingPerUnit` | Global funding accumulator |
| `lastFundingUpdateTime` | Funding timestamp |
| `userFundingSnapshot` | Per-user funding checkpoint |
| `userBuyOrderValue` / `userSellOrderValue` | Cached order values for margin calculation |
| `orders` | Order book storage |
| `priceOrdersLongQueue` / `priceOrdersShortQueue` | FIFO queues at each price |
| `participantOrderIdsIndex` | User → order IDs lookup |
| `activeBidPrices` / `activeAskPrices` | Sorted price ladders |
| `positions` | Position state |
| `usersWithPositions` | Dead legacy enumeration slot retained only for proxy layout compatibility |

All fine.

---

## Summary

| Value | Current | Verdict |
|-------|---------|---------|
| `minimumPriceIncrement` | `constant = 1e4` | ✅ Already correct | $0.01 in USDC (6 decimals) |
| `CONTRACT_SIZE_HPS_DAY` | `constant` | ✅ |
| `QUANTITY_DECIMALS` | `constant` | ✅ |
| `FUNDING_DECIMALS` | `constant` | ✅ |
| `MAX_ORDERS_PER_PARTICIPANT` | `constant` | ✅ |
| `MAX_PRICE_LEVELS_PER_SIDE` | `constant` | ✅ |
| `MAX_ORACLE_STALENESS` | `constant` | ✅ |
| `VERSION` | `constant` | ✅ |
| All fee/funding params | proxy + setter | ✅ |
| `vault` | proxy, init only | ✅ |
| `portfolioMargin` | proxy + setter | ✅ `PortfolioMarginUpdated` added |
| `priceOracle` | proxy + setter | ✅ `OracleUpdated` added |
| `marginPercent` | — | 🔴 **Removed** (dead — never written or read) |
| `maintenanceMarginPercent` | — | 🔴 **Removed** (dead — never written or read) |
