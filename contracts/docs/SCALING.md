# HashPowerPerpsDEX.sol Scaling Analysis

## Current Issues

### Bottleneck 1: Price Level Insertion — O(P)

`_addPriceLevel` linearly scans the sorted linked list to find the insertion point. P = number of active price levels per side. No upper bound on P. At 500 levels, a worst-case insert costs ~150K gas just for traversal. At 1,000 levels: ~300K gas.

### Bottleneck 2: Order Matching — O(P × Q)

`_matchWithOppositeOrders` walks price levels; `_matchOrdersAtPrice` walks the FIFO queue at each level. A wide limit order can traverse the entire book. 100 levels × 50 orders = 5,000 iterations at ~5-10K gas each = 25-50M gas, exceeding block limits.

### Bottleneck 3: Unbounded View Functions

- `getUsersWithPositions()` — returns all users, no pagination
- `getQuantityAtPrice()` — iterates all orders at a price level

### Bottleneck 4: Price Level Pollution / DoS

An attacker with many addresses can create thousands of distinct price levels with tiny orders, making `_addPriceLevel` and matching expensive for everyone.

---

## How Other On-Chain Order Books Solve These

### Option A: Tick Bitmap (Uniswap V3 style)

Replace the sorted linked list with a `mapping(int16 => uint256)` bitmap where each bit represents a price level. Finding the next active price is a bitwise operation — O(1) per 256-tick word.

**Pros:**
- O(1) price level insertion and removal
- O(1) next-price lookup within a word, O(W) across words (W = words between prices, usually 1-2)
- Battle-tested (Uniswap V3)

**Cons:**
- Prices must map to integer tick indices — requires a tick spacing parameter
- Less flexible for arbitrary price precision
- Does not solve the per-price-level order queue iteration

**Good fit when:** price levels are discrete ticks with known spacing (already the case with `minimumPriceIncrement`).

### Option B: Hashmap + Calldata-Sorted Prices (0xTrojan CLOB)

Don't sort prices on-chain at all. Store price points in flat hashmaps: `mapping(uint256 => PricePoint)`. Limit order placement is O(1). The sorted price list is passed as calldata by the market order taker, who has the incentive to provide correct sorting (they want the best price). Only time priority is verified on-chain.

**Cranked variant:** market orders mark volume as "claimable" at each price point (~29K gas per level). Makers claim separately in O(1) each. Matching and settlement are decoupled.

**Crankless variant:** market orders fill individual orders directly (~17K gas per fill). Caller provides sorted order IDs as calldata and controls how many fills per tx.

**Pros:**
- O(1) limit order placement and cancellation
- No on-chain sorting = no price level pollution attack surface
- Caller controls matching gas budget
- Removes MEV from price ordering

**Cons:**
- Requires off-chain infrastructure (UI/keeper) to compute sorted price lists
- Cranked variant adds UX complexity (makers must claim)
- More complex smart contract logic for time-priority validation (sliding window)

**Benchmarks (from 0xTrojan):**
- Limit order: ~135K gas (constant regardless of book depth)
- Cancel: ~80K gas
- Market order: ~29K gas per price level (cranked) / ~17K per fill (crankless)
- Claim: ~78K gas

### Option C: Radix Tree (Hanji style)

Store orders in a radix tree keyed by (price, orderNumber). Each node aggregates child quantities (Sum Qty, Sum Value). Matching finds the largest sub-tree fillable by the incoming order and removes it atomically.

**Pros:**
- O(log N) matching, hard cap at 127 steps (64-bit key)
- Batch fills via subtree removal
- Fully on-chain, no off-chain dependencies

**Cons:**
- Complex implementation
- Limited to 6-digit price precision
- Higher constant factor than bitmap or hashmap approaches
- Not a standard/audited library

### Option D: Custom L1 / Off-Chain Matching (Hyperliquid / dYdX)

Move matching off-chain entirely. Only settlement goes on-chain.

- **Hyperliquid:** Custom L1 with matching engine in consensus layer. 200K+ TPS, ~200ms finality. No gas limits on matching.
- **dYdX V4:** Cosmos SDK chain. Off-chain matching by validators, on-chain settlement.

**Pros:**
- No EVM gas constraints
- Unlimited order book depth and matching speed

**Cons:**
- Requires building/running a separate chain or validator set
- Not applicable if you want to deploy on an existing EVM chain
- Massive infrastructure overhead

### Option E: LOBSTER (Clober style — segmented segment tree + octopus heap)

Use **manual claiming** and **claim ranges** so the taker does not iterate every maker in one transaction. Per-price FIFO depth uses a **segmented segment tree** (packed leaves, shallow levels, few `sstore`s per update). Across prices, **compress price to a small index (CPI)** and use an **octopus heap** plus **leaf bitmap** to find the next active level without scanning every tick in a gap.

**Pros:**
- Bounded work for queue sums/updates (segment tree path)
- Skips empty price gaps (heap + bitmap) instead of per-tick scans
- Fully on-chain matching with gas costs tuned for EVM (Clober production path)

**Cons:**
- Very high implementation complexity (custom layouts, not a standard library)
- Manual claiming changes settlement UX (makers claim separately)
- Requires careful parameterization (queue capacity, CPI, quote unit)

**Good fit when:** you want Clober-class on-chain order book engineering on a general EVM chain and can commit to the claiming model and audit surface.

---

## Comparison Matrix

| Aspect | Current (Linked List) | Tick Bitmap | Hashmap+Calldata | Radix Tree | LOBSTER (Clober) | Custom L1 |
|---|---|---|---|---|---|---|
| Limit order gas | O(P) | O(1) | O(1) | O(log N) | O(log N) path, low sstore count (designed) | N/A |
| Cancel gas | O(1) | O(1) | O(1) | O(log N) | O(log N) | N/A |
| Matching gas | O(P×Q) unbounded | O(W×Q) | Caller-controlled | O(log N) capped | Taker not O(makers); claims separate | Unlimited |
| Price level insert | O(P) linear scan | O(1) bitmap flip | O(1) hashmap write | O(log N) | Heap + bitmap (often cheap) | N/A |
| Max price levels | Unbounded (DoS risk) | 2^24 (bitmap) | Unbounded (no DoS) | 2^64 | CPI + heap (bounded index) | Unlimited |
| Off-chain deps | None | None | Keeper/UI for sorting | None | None (claim txs optional infra) | Full infra |
| Implementation complexity | Low | Medium | Medium-High | High | Very High | Very High |
| Audited/battle-tested | No | Yes (Uni V3) | Research-stage | Production (Hanji) | Production (Clober) | Production |

---

## Recommended Quick Fixes (Before Architecture Change)

These can be applied to the current linked-list design to mitigate the worst issues:

1. **Add `MAX_PRICE_LEVELS_PER_SIDE`** — cap active bid/ask price levels (200 per side), revert on overflow ✅
2. **Add `maxFills` parameter to `createOrder`** — let the caller cap matching iterations per tx
3. **Add `minimumMarginPerOrder`** — enforce a minimum margin (collateral) locked per resting order, making price-level spam uneconomic regardless of leverage ✅
4. **Paginate view functions** — `getUsersWithPositions(offset, limit)`, `getQuantityAtPrice` with iteration cap

## Recommended Long-Term Architecture

For an EVM-deployed perps contract, **Option A (tick bitmap) + quick fixes** is the most practical path:

- Prices already use `minimumPriceIncrement`, which maps directly to tick spacing
- Tick bitmap eliminates the O(P) insertion bottleneck entirely
- Combined with a `maxFills` cap, matching gas becomes predictable
- Well-understood pattern with audited reference code (Uniswap V3 TickBitmap.sol)

If deeper changes are acceptable, **Option B (hashmap + calldata)** gives the best gas profile but requires off-chain infrastructure for price sorting and adds complexity.

For **maximum** fully on-chain density without a dedicated chain, **Option E (LOBSTER)** matches production Clober-style engineering (segmented segment trees, octopus heap, manual claiming) at the cost of the highest implementation and audit burden — see `SCALING_OPTION_E_LOBSTER.md`.
