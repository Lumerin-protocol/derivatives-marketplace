# Perps Indexer

A Graph Protocol subgraph that indexes the `HashPowerPerpsDEX` contract, turning on-chain events into a queryable GraphQL API for orders, trades, positions, collateral, and liquidation data.

## Schema

### Entities

| Entity | Mutability | Description |
| --- | --- | --- |
| **Perps** | mutable | Singleton (id=0). Contract config, pool balances, and global stats (total users/orders/trades/volume/liquidations). |
| **User** | mutable | Per-address account: collateral balance, net position, order/trade counts, realized PnL, and relations to all other entities. |
| **Order** | mutable | An order on the book. Tracks price, quantity, buy/sell side, status (`ACTIVE` / `FILLED` / `CANCELLED` / `PARTIAL`), and fill progress. |
| **Trade** | immutable | A matched trade between a buyer and seller with price, quantity, volume, and the maker order reference. |
| **PositionSnapshot** | immutable | Position state after each trade: trade price/quantity and resulting net position with entry price. |
| **PositionClose** | immutable | Emitted when a position is fully or partially closed: quantity closed and realized PnL. |
| **Liquidation** | immutable | Liquidation event: user, liquidator, position size, PnL, and liquidator fee. |
| **CollateralEvent** | immutable | Deposit or withdrawal of collateral. |
| **PriceLevel** | mutable | Aggregated order book level: total quantity and order count at a given price and side (bid/ask). |

### Event Handlers

The subgraph listens to all `HashPowerPerpsDEX` contract events:

- **Order events** — `OrderCreated`, `OrderFilled`, `OrderCancelled`, `OrderUpdated`, `OrderMatched`
- **Position events** — `PositionTrade`, `PositionClosed`, `PositionLiquidated`
- **Collateral events** — `CollateralAdded`, `CollateralRemoved`
- **Config events** — `OrderFeeUpdated`, `MarginPercentUpdated`, `MaintenanceMarginPercentUpdated`, `LiquidationFeeUpdated`, `MinimumPriceIncrementUpdated`
- **Lifecycle events** — `Initialized`

On initialization, the handler also reads current contract state (addresses, config, balances) via `try_*` calls to populate the `Perps` singleton.

## Local Development

### Prerequisites

- Docker (for graph-node, IPFS, and Postgres)
- pnpm
- A running Ethereum node (local or remote) for graph-node to connect to

### 1. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

```
NETWORK=arbitrum-sepolia
PERPS_ADDRESS=0x...
PERPS_START_BLOCK=123456
SUBGRAPH_ETH_NODE=arbitrum-sepolia:https://arb-sepolia.g.alchemy.com/v2/YOUR_KEY
```

`SUBGRAPH_ETH_NODE` is the `ethereum` connection string for graph-node in `network:url` format.

### 2. Start infrastructure

```bash
pnpm indexer   # docker-compose up (graph-node + IPFS + Postgres)
```

This starts:
- **graph-node** on ports 8000 (GraphQL), 8001 (WebSocket), 8020 (JSON-RPC admin), 8030 (index status), 8040 (metrics)
- **IPFS** on port 5001
- **Postgres** on port 5432

### 3. Build and deploy

```bash
pnpm setup-local
```

This runs the full pipeline: template substitution, codegen, build, create, and deploy. Alternatively, step by step:

```bash
pnpm prepare-local    # Substitute env vars into subgraph.yaml
pnpm codegen          # Generate AssemblyScript types from schema + ABI
pnpm build            # Compile the subgraph
pnpm create-local     # Register subgraph name with graph-node
pnpm deploy-local     # Deploy to local graph-node
```

### 4. Query

The GraphQL endpoint is available at:

```
http://localhost:8000/subgraphs/name/perps
```

## Available Scripts

| Script | Description |
| --- | --- |
| `pnpm indexer` | Start graph-node + IPFS + Postgres via Docker Compose |
| `pnpm setup-local` | Full local pipeline: prepare, codegen, build, create, deploy |
| `pnpm prepare-local` | Substitute `.env` vars into `subgraph.yaml` from template |
| `pnpm codegen` | Generate AssemblyScript types |
| `pnpm build` | Compile the subgraph |
| `pnpm create-local` | Register subgraph with local graph-node |
| `pnpm deploy-local` | Deploy subgraph to local graph-node |
| `pnpm remove-local` | Remove subgraph from local graph-node |
| `pnpm deploy` | Deploy to The Graph Studio (hosted) |
| `pnpm test` | Run Matchstick unit tests |
| `pnpm clean` | Remove generated files, build artifacts, and data |

## Configuration

The subgraph manifest is generated from `subgraph.template.yaml` using `envsubst`. The template contains placeholders for:

- `${SUBGRAPH_NETWORK}` — target network name
- `${PERPS_ADDRESS}` — deployed contract address
- `${PERPS_START_BLOCK}` — block to start indexing from

The ABI is read from `../contracts/abi/HashPowerPerpsDEX.json`, so the contracts package must be built first.

## Example Queries

**Contract stats:**

```graphql
{
  perps(id: 0) {
    totalUsers
    totalOrders
    activeOrders
    totalTrades
    totalVolume
    totalLiquidations
    reservePoolBalance
    collectedFeesBalance
  }
}
```

**User portfolio:**

```graphql
{
  user(id: "0x...") {
    collateralBalance
    netQuantity
    aggregatedEntryPrice
    realizedPnl
    activeOrderCount
    tradeCount
  }
}
```

**Order book depth:**

```graphql
{
  priceLevels(where: { orderCount_gt: 0 }, orderBy: price, orderDirection: desc) {
    price
    isBid
    totalQuantity
    orderCount
  }
}
```

**Recent trades:**

```graphql
{
  trades(first: 50, orderBy: timestamp, orderDirection: desc) {
    buyer { address }
    seller { address }
    price
    quantity
    volume
    timestamp
  }
}
```

**Open positions:**

```graphql
{
  users(where: { netQuantity_not: 0 }, orderBy: lastActivityAt, orderDirection: desc) {
    address
    netQuantity
    aggregatedEntryPrice
    collateralBalance
    realizedPnl
  }
}
```

**Top traders by realized PnL:**

```graphql
{
  users(first: 10, orderBy: realizedPnl, orderDirection: desc, where: { tradeCount_gt: 0 }) {
    address
    realizedPnl
    tradeCount
    netQuantity
  }
}
```

A full set of reusable queries is available in `tests/subgraph-queries.ts`. The test runner in `tests/queries.smoke.ts` can be used to smoke-test the subgraph against a running instance (`pnpm test:smoke`).
