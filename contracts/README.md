## How It Works

### On-Chain Order Book

The core of the system is a fully on-chain central limit order book (CLOB). Users place limit orders at a specific price and signed quantity (positive = buy/long, negative = sell/short). Orders are stored in FIFO queues per price level, with sorted linked lists tracking active bid prices (highest first) and ask prices (lowest first).

When a new order arrives, the matching engine runs in three stages:

1. **Self-offset** — cancels the user's own opposite orders that would cross the incoming limit price, avoiding self-trading.
2. **Match** — walks the opposite side of the book and fills against resting orders at the maker's price (price improvement for the taker). Partial fills leave the remainder on the book.
3. **Post** — any unmatched quantity is inserted into the book at the limit price.

An order fee is charged per submission, and margin is checked after every order.

### Order Matching

Every order goes through `createOrder(price, quantity)` where `price` is a limit price and `quantity` is signed (positive = buy/long, negative = sell/short). The function processes the order in three sequential stages, each consuming as much of the remaining quantity as possible before passing the rest to the next stage.

```mermaid
flowchart TD
    A["createOrder(price, qty)"] --> B[1. Self-Offset]
    B --> C{remaining qty?}
    C -->|Yes| D[2. Match]
    C -->|No| G[Done]
    D --> E{remaining qty?}
    E -->|Yes| F[3. Post to Book]
    E -->|No| G
    F --> G
    G --> H[Margin Check]
```

#### Stage 1 — Self-Offset

Before matching against other participants, the engine cancels the caller's own resting orders on the opposite side that would cross the incoming limit price. This prevents self-trading.

`_offsetUserOppositeOrders` walks the opposite price list (asks for a buy, bids for a sell) from best price outward. At each price level that crosses the limit, `_offsetOrdersAtPrice` iterates the user's own orders at that price in reverse and reduces both the resting order and the incoming quantity by the overlap amount. Fully consumed resting orders are removed from the book.

#### Stage 2 — Match

`_matchWithOppositeOrders` walks the opposite side of the book from the best price outward, stopping when the price no longer crosses the limit or the incoming quantity is exhausted.

At each price level, `_matchOrdersAtPrice` iterates the FIFO queue front-to-back. For each resting order (skipping the taker's own orders), `_executeMatch` runs:

1. **Match amount** — `min(abs(resting order qty), abs(incoming qty))`
2. **Execution price** — always the maker's (resting) price, giving the taker price improvement when the book price is better than the limit
3. **Position updates** — `_createPosition` determines buyer/seller from the quantity sign, then calls `_updateUserPosition` for each side (settling funding, updating net position, calculating PnL)
4. **Fees** — taker and maker fees are charged on the notional value of the match
5. **Book cleanup** — the resting order's quantity is reduced; if fully filled, the order is removed and the price level is cleaned up if empty

#### Stage 3 — Post

Any remaining quantity after matching is inserted into the book as a new resting order:

1. An `Order` struct is created with a unique ID (hash of participant, price, quantity, timestamp, nonce)
2. The order is pushed to the back of the FIFO queue at its price level (`priceOrdersLongQueue` for bids, `priceOrdersShortQueue` for asks)
3. The price level is inserted into the sorted linked list (`activeBidPrices` descending, `activeAskPrices` ascending) if not already present
4. The order is indexed by participant and by participant+price for efficient lookup during self-offset and cancellation

After all three stages, `_ensureSufficientMargin` verifies the caller still meets the initial margin requirement.

#### Data Structures

| Structure                                                      | Purpose                                                                                                                                         |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `activeBidPrices` / `activeAskPrices`                          | Sorted linked lists of active price levels (bids descending, asks ascending). Enable walking the book from best price outward in O(1) per step. |
| `priceOrdersLongQueue[price]` / `priceOrdersShortQueue[price]` | FIFO linked-list queues of order IDs at each price level. Ensure time priority within a price.                                                  |
| `participantOrderIdsIndex[user]`                               | Set of all order IDs belonging to a user. Used for cancellation and margin calculations. Capped at `MAX_ORDERS_PER_PARTICIPANT` (100).          |
| `participantPriceOrderIdsIndex[user][price]`                   | Set of a user's order IDs at a specific price. Enables efficient self-offset lookup.                                                            |
| `userTotalOrderValue[user]`                                    | Cached sum of notional value across all of a user's resting orders. Updated incrementally on create/fill/cancel to avoid re-scanning.           |

### Collateral and Margin

Users deposit an ERC-20 collateral token (e.g. USDC) into the contract, which mints an internal ERC-20 receipt token 1:1. This balance serves as the user's available margin.

Two margin tiers are enforced:

- **Initial margin** (`marginPercent`) — required to place orders and hold positions. Calculated as a percentage of (open order notional + position notional at mark price + any unrealized loss).
- **Maintenance margin** (`maintenanceMarginPercent`) — a lower threshold below which a position becomes liquidatable. Uses the same formula but with a smaller percentage.

#### Margin Calculation

Two margin tiers use the same structure but differ in which percentage is applied to the position component:

**Initial margin** (`_getInitialMargin`) — uses `marginPercent` for positions. Checked by `createOrder` (non-reduce-only) and `removeCollateral`:

```
initialMargin = orderMargin + positionMargin

orderMargin    = userTotalOrderValue * marginPercent / 100
positionMargin = positionValue * marginPercent / 100
               + abs(unrealizedLoss)
               + pendingFundingOwed
```

**`getMaintenanceMargin(user)`** — uses `maintenanceMarginPercent` for positions. Used by `isLiquidatable`:

```
maintenanceMargin = orderMargin + positionMargin

orderMargin       = userTotalOrderValue * marginPercent / 100
positionMargin    = positionValue * maintenanceMarginPercent / 100
                  + abs(unrealizedLoss)
                  + pendingFundingOwed
```

Where:

- `userTotalOrderValue` — cached sum of `price * abs(qty) / 10^QUANTITY_DECIMALS` across all resting orders (updated incrementally, never re-scanned)
- `positionValue` — `oraclePrice * abs(netQuantity) / 10^QUANTITY_DECIMALS`
- `unrealizedLoss` — `(oraclePrice - entryPrice) * netQuantity / 10^QUANTITY_DECIMALS`, only added when negative (loss). Gains are ignored to be conservative.
- `pendingFundingOwed` — only added when positive (user owes funding). Funding the user would receive is ignored.

This creates a buffer zone between initial and maintenance margin. Users below initial margin cannot increase exposure or withdraw, but are not liquidated until they fall below maintenance margin. Reduce-only orders (opposite side of position, not exceeding position size) bypass the margin check entirely, ensuring users can always exit a losing position.

### Positions and PnL

Each user has a single **net position** (long or short) with a weighted-average entry price. When a trade occurs:

- **Same direction** — the position grows and the entry price is recalculated as a weighted average.
- **Opposite direction (partial offset)** — the overlapping portion is closed at the trade price, realized PnL is settled immediately, and the remainder stays open.
- **Opposite direction (full offset or flip)** — the entire original position is closed and settled. Any excess quantity opens a new position in the opposite direction at the trade price.

Realized PnL is settled through a **reserve pool**: profits are paid from the pool to the user, and losses are transferred from the user back into the pool.

### Liquidation

Anyone can call `liquidate(user)` if the user's collateral falls below their maintenance margin. The liquidation:

1. Calculates PnL at the current oracle price and settles it against the reserve pool.
2. Pays a fixed liquidation fee to the caller from the user's remaining balance.
3. Deletes the position entirely.

### Price Oracle

The contract uses a Chainlink `AggregatorV3Interface` oracle for the mark price. Prices are scaled to match collateral token decimals and rounded to the configured `minimumPriceIncrement`. A staleness check (1 hour max) rejects outdated oracle data.

### Upgradeability

The contract uses the UUPS proxy pattern (OpenZeppelin) so the implementation can be upgraded by the owner without redeploying state.

### Funding Fees

Funding fees keep the perpetual price anchored to the spot price by charging/rewarding position holders based on the deviation between the **mark price** (order book mid-price) and the **index price** (oracle). When mark > index, longs pay shorts (and vice versa). Funding accrues continuously (per-second) and settles lazily through the reserve pool when users interact.

```mermaid
flowchart TD
    A[Mark Price vs Index Price] --> B{mark > index?}
    B -->|Yes| C[Positive Funding Rate]
    B -->|No| D[Negative Funding Rate]
    C --> E[Longs Pay -> Reserve Pool -> Shorts Receive]
    D --> F[Shorts Pay -> Reserve Pool -> Longs Receive]

    G["User Interaction (createOrder, liquidate)"] --> H[_updateGlobalFunding]
    H --> I[_settleFunding per user]
    I --> J[Transfer to/from reserve pool]
```

#### State Variables

```solidity
uint256 private constant FUNDING_PRECISION = 1e18;

int256 public cumulativeFundingPerUnit;   // Global cumulative funding (tokenDecimals * FUNDING_PRECISION)
uint256 public lastFundingUpdateTime;     // Last timestamp funding was updated
uint256 public fundingRateMaxBps;         // Max absolute funding rate per fundingPeriod in bps (e.g., 100 = 1%)
uint256 public fundingPeriod;             // Period for max rate (e.g., 86400 = 24 hours)
mapping(address => int256) private userFundingSnapshot; // Per-user snapshot of cumulativeFundingPerUnit
```

#### Core Funding Functions

- **`_getCurrentCumulativeFunding()`** (private view) — Computes the theoretical cumulative funding as of `block.timestamp` without writing state. Used by both the state-mutating update and view functions.
  - Gets mark price as `(bestBid + bestAsk) / 2`; if either side is empty, returns current stored value (no funding accrues without a two-sided book)
  - Calculates `fundingRate = (markPrice - indexPrice) * PRECISION / indexPrice`, clamped to `[-maxRate, maxRate]`
  - Computes `deltaCumFunding = fundingRate * indexPrice * timeElapsed / fundingPeriod`
  - Returns `cumulativeFundingPerUnit + deltaCumFunding`

- **`_updateGlobalFunding()`** (private) — Called before any position-affecting operation. Writes the new cumulative funding and `lastFundingUpdateTime`.

- **`_settleFunding(address user)`** (private) — Settles pending funding for a specific user:
  - Computes `pendingFunding = netQuantity * (currentCumFunding - userSnapshot) / (QUANTITY_DECIMALS_SCALE * FUNDING_PRECISION)`
  - Positive result = user owes (long paying in positive-rate environment) -> transfer from user to reserve pool
  - Negative result = user receives -> transfer from reserve pool to user (capped by reserve pool balance)
  - Updates `userFundingSnapshot[user]` and emits `FundingSettled`

- **`updateFunding()`** (external) — Public standalone function so keepers can trigger funding updates even during idle periods.

- **`getPendingFunding(address user)`** (public view) — Returns the pending funding for a user using `_getCurrentCumulativeFunding()`.

#### Integration with Existing Functions

- **`createOrder()`** — Calls `_updateGlobalFunding()` at the top. Per-user settlement happens inside `_updateUserPosition` during matching.
- **`_updateUserPosition()`** — Calls `_settleFunding(user)` at the very start, before any position logic, ensuring funding is settled at the old position size.
- **`liquidate()`** — Calls `_updateGlobalFunding()` + `_settleFunding(user)` before liquidation logic. Pending funding debt affects liquidatability.
- **`getMaintenanceMargin()`** — Includes pending funding owed (if positive) in the margin requirement.
- **`getUnrealizedPnl()`** — Subtracts pending funding from unrealized PnL so users see the full picture.

#### Position Lifecycle and Funding Snapshots

- When a position is **opened** (new from zero), set `userFundingSnapshot[user] = cumulativeFundingPerUnit`
- When a position is **closed** (deleted), settle funding first, then clean up snapshot
- When a position is **modified** (increased/decreased), settle funding at old quantity, then update snapshot

This is handled by calling `_settleFunding` at the start of `_updateUserPosition`, which covers all cases.

#### Key Math

```
fundingRate = clamp((markPrice - indexPrice) / indexPrice, -maxRate, maxRate)
cumulativeFundingPerUnit += fundingRate * indexPrice * timeElapsed / fundingPeriod
pendingFunding = netQuantity * deltaCumulativeFunding / QUANTITY_DECIMALS_SCALE / FUNDING_PRECISION
```

- Positive `pendingFunding` = user owes (long with positive rate, or short with negative rate)
- Negative `pendingFunding` = user receives
- All payments route through the reserve pool (`balanceOf(address(this))`)
