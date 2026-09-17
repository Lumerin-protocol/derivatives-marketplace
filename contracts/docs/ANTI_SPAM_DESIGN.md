# Anti-Spam Mechanism Design Decisions

This document captures the decision-making process for choosing anti-spam / anti-pollution mechanisms for the HashPowerPerpsDEX order book.

---

## Problem Statement

The on-chain order book uses a `StructuredLinkedList` for sorted price levels. An attacker can cheaply create many distinct price levels with tiny orders across multiple addresses (Sybil attack), degrading gas performance for all users:

- **`_addPriceLevel`** walks the linked list to find insertion position — O(P) where P = number of active price levels
- **`_matchWithOppositeOrders`** iterates across price levels and orders — O(P x Q)
- With enough price levels, legitimate trades become too expensive to execute

---

## Options Considered

### Option 1: Per-Order Deposit, Forfeit on Cancel

**Mechanism:** Every resting order pays a small deposit (e.g., 0.10 USDC). Refunded on fill, forfeited on cancel.

**Pros:**
- Solves both price-level spam and order-queue spam at existing prices
- Simple to implement and reason about
- Negligible for real traders

**Cons:**
- **Penalizes market makers.** Makers constantly re-quote by canceling and re-placing orders as the market moves. Losing a deposit on every cancel adds direct cost to quoting, reducing liquidity provision. This was the decisive rejection reason.

**Verdict:** Rejected — disincentivizes makers.

---

### Option 2: Price-Level Fee, Refund on Fill

**Mechanism:** When an order is the first at a new price level (triggers `_addPriceLevel`), charge an extra fee. Refund on fill; forfeit on cancel.

**Pros:**
- Targeted: only charges the order that creates a new level

**Cons:**
- Same maker penalty as Option 1 — a maker who quotes at a new price and later cancels loses the fee
- Asymmetric: first mover at a price pays, subsequent orders are free
- Edge cases around partial fills, price level recreation, and deposit ownership when the original order cancels but others remain

**Verdict:** Rejected — still penalizes makers on cancel.

---

### Option 3: Price-Level Deposit, Refund on Cancel AND Fill

**Mechanism:** The first order at a new price level locks a deposit (e.g., 50 USDC). Refunded on both cancel and fill — it's locked capital, not a fee.

**Pros:**
- No penalty on cancel: maker re-quotes freely, deposit is always returned
- Raises capital lockup 50x vs. margin-only approaches (10,200 USDC to fill 200 levels vs. 200 USDC)
- Zero net cost to makers (only opportunity cost of locked capital)

**Cons:**
- Added contract complexity: need `mapping(bytes32 => bool)` to track which orders paid a deposit
- Extra storage write per new price level
- Edge case: first order cancels, but other orders remain at that price — deposit goes back to original user, nobody else paid

**Verdict:** Viable but deferred — adds complexity that may not be needed when combined with simpler mechanisms. Worth revisiting if deploying on cheap-gas L2 where transaction cost alone doesn't deter spam.

---

### Option 4: Minimum Order Value (`minimumOrderValue`)

**Mechanism:** Enforce a minimum notional value per resting order (e.g., 10 USDC). Orders below this threshold are rejected.

**Pros:**
- Simplest to implement
- No fees, no forfeit, no friction for makers
- Makes price-level spam require real capital

**Cons:**
- **Leverage bypass:** With 10% margin, a 10 USDC notional order only locks 1 USDC in margin. To fill 200 price levels, an attacker only needs 200 USDC — a low bar.
- If `marginPercent` is later reduced (e.g., 10% to 5%), the locked capital per order drops further, weakening the protection without changing any spam parameter.

**Verdict:** Implemented initially, then replaced by Option 5.

---

### Option 5: Minimum Margin Per Order (`minimumMarginPerOrder`) — deprecated

**Historical mechanism:** Enforce a minimum margin per resting order and reject orders below the threshold.

**Pros:**
- Directly expresses "you must lock this much real capital per order"
- Decoupled from margin percent changes: if `marginPercent` drops from 10% to 5%, the minimum locked capital per order stays the same
- No fees, no forfeit, no friction for makers
- Spammer cannot bypass via high leverage (margin percent is global, not per-order)

**Cons:**
- Slightly more complex validation than raw notional check (one extra multiplication)

**Verdict:** Retired from runtime enforcement. A flat per-order floor conflicts with portfolio netting and duplicates the PME's canonical portfolio IM calculation. The storage slot, getter, setter, event, and `OrderMarginTooLow` declaration remain for compatibility only.

---

### MAX_PRICE_LEVELS_PER_SIDE (constant = 200) :white_check_mark:

**Mechanism:** Hard cap on the number of active price levels per side (bid/ask). Revert when a new price level would exceed the cap. Orders at existing price levels are unaffected.

**Rationale:**
- Even with minimum margin, the linked list iteration is O(P) — capping P puts a hard bound on worst-case gas
- 200 levels per side is generous for normal trading (most liquid markets have 20-50 active levels)
- Constant, not configurable — eliminates admin risk of accidentally setting it too high

**Verdict:** Adopted as a constant.

---

## Final Design

```
┌──────────────────────────────────────────────────────┐
│                   createOrder()                       │
│                                                      │
│  1. Match with opposite orders (taker fills)         │
│                                                      │
│  2. If remaining qty → resting order:                │
│     ┌──────────────────────────────────────────┐     │
│     │  Check: user orders < MAX_ORDERS (100)   │     │
│     │  Revert: MaxOrdersPerParticipantReached  │     │
│     └──────────────────────────────────────────┘     │
│     ┌──────────────────────────────────────────┐     │
│     │  If new price level:                     │     │
│     │  Check: levels < MAX_PRICE_LEVELS (200)  │     │
│     │  Revert: MaxPriceLevelsReached()         │     │
│     └──────────────────────────────────────────┘     │
│                                                      │
│  3. Add order to book                                │
└──────────────────────────────────────────────────────┘
```

## Historical Spam Cost Analysis

The following figures described the deprecated per-order floor and are not current protocol guarantees.

With the former `minimumMarginPerOrder = 0.5 USDC` and `marginPercent = 10%`:

| Attack | Capital Required | Recoverable? |
|---|---|---|
| Fill 200 bid levels (1 side) | 200 × 0.5 = **100 USDC** locked | Yes, on cancel |
| Fill both sides (400 levels) | **200 USDC** locked | Yes, on cancel |
| Fill both sides + margin overhead | ~**240 USDC** locked | Yes, on cancel |

With the former `minimumMarginPerOrder = 10 USDC`:

| Attack | Capital Required | Recoverable? |
|---|---|---|
| Fill 200 bid levels (1 side) | 200 × 10 = **2,000 USDC** locked | Yes, on cancel |
| Fill both sides (400 levels) | **4,000 USDC** locked | Yes, on cancel |

Changing `minimumMarginPerOrder` now updates only the compatibility getter and event; it does not change order acceptance.

## Key Insight: Why Margin, Not Notional

```
minimumMarginPerOrder = minimumOrderValue × marginPercent / 100
```

They were mathematically interchangeable at a fixed `marginPercent`. This comparison is retained as historical design context; current collateral adequacy comes from PME portfolio IM.
