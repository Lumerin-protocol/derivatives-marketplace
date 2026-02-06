## How It Works

### On-Chain Order Book

The core of the system is a fully on-chain central limit order book (CLOB). Users place limit orders at a specific price and signed quantity (positive = buy/long, negative = sell/short). Orders are stored in FIFO queues per price level, with sorted linked lists tracking active bid prices (highest first) and ask prices (lowest first).

When a new order arrives, the matching engine runs in three stages:

1. **Self-offset** — cancels the user's own opposite orders that would cross the incoming limit price, avoiding self-trading.
2. **Match** — walks the opposite side of the book and fills against resting orders at the maker's price (price improvement for the taker). Partial fills leave the remainder on the book.
3. **Post** — any unmatched quantity is inserted into the book at the limit price.

An order fee is charged per submission, and margin is checked after every order.

### Collateral and Margin

Users deposit an ERC-20 collateral token (e.g. USDC) into the contract, which mints an internal ERC-20 receipt token 1:1. This balance serves as the user's available margin.

Two margin tiers are enforced:

- **Initial margin** (`marginPercent`) — required to place orders and hold positions. Calculated as a percentage of (open order notional + position notional at mark price + any unrealized loss).
- **Maintenance margin** (`maintenanceMarginPercent`) — a lower threshold below which a position becomes liquidatable. Uses the same formula but with a smaller percentage.

Withdrawals are blocked if removing collateral would breach the initial margin requirement.

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
