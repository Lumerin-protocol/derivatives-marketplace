# PerpsSimple Subgraph

This subgraph indexes the PerpsSimple perpetual trading contract to track orders, trades, positions, and user activity.

## Entities

### Core Entities

- **Perps**: Singleton entity for contract-wide state and configuration

  - Contract addresses (collateral token, price oracle)
  - Configuration (margin %, liquidation fee, order fee, price increment)
  - Global stats (total users, orders, trades, volume, liquidations)

- **User**: Tracks user accounts and their activity

  - Collateral balance and deposit/withdrawal history
  - Current net position (quantity and entry price)
  - Order and trade counts
  - Realized PnL

- **Order**: Active orders in the order book

  - Price, quantity, buy/sell direction
  - Status (ACTIVE, FILLED, CANCELLED, PARTIAL)
  - Fill progress

- **Trade**: Matched trades between users

  - Buyer, seller, price, quantity, volume
  - Maker order reference

- **PositionSnapshot**: Position state after each trade

  - Trade details and resulting position state

- **PositionClose**: Position close events

  - Quantity closed and realized PnL

- **Liquidation**: Liquidation events

  - User, liquidator, position size, PnL, fee

- **CollateralEvent**: Deposit and withdrawal events

- **PriceLevel**: Order book aggregation by price level
  - Total quantity and order count per price

## Event Handlers

### Order Events

- `OrderCreated`: New order added to book
- `OrderFilled`: Order fully matched
- `OrderCancelled`: Order cancelled by user
- `OrderUpdated`: Order partially filled
- `OrderMatched`: Trade executed between buyer and seller

### Position Events

- `PositionTrade`: Position updated after trade
- `PositionClosed`: Position fully or partially closed with PnL
- `PositionLiquidated`: Position liquidated

### Collateral Events

- `CollateralAdded`: User deposited collateral
- `CollateralRemoved`: User withdrew collateral

### Config Events

- `OrderFeeUpdated`, `MarginPercentUpdated`, `MaintenanceMarginPercentUpdated`
- `LiquidationFeeUpdated`, `MinimumPriceIncrementUpdated`

## Setup

1. Copy `.env.example` to `.env` and configure:

   ```
   NETWORK=arbitrum-sepolia
   PERPS_ADDRESS=0x...
   START_BLOCK=123456
   ```

2. Generate code and build:

   ```bash
   pnpm install
   pnpm prepare-local
   pnpm codegen
   pnpm build
   ```

3. Deploy locally:
   ```bash
   pnpm indexer          # Start graph-node via docker
   pnpm create-local     # Create subgraph
   pnpm deploy-local     # Deploy subgraph
   ```

## Example Queries

```graphql
# Get contract stats
{
  perps(id: 0) {
    totalUsers
    totalTrades
    totalVolume
    activeOrders
  }
}

# Get user with positions and orders
{
  user(id: "0x...") {
    collateralBalance
    netQuantity
    aggregatedEntryPrice
    realizedPnl
    orders(where: { status: "ACTIVE" }) {
      price
      quantity
      isBuy
    }
  }
}

# Get recent trades
{
  trades(orderBy: timestamp, orderDirection: desc, first: 50) {
    buyer {
      address
    }
    seller {
      address
    }
    price
    quantity
    volume
    timestamp
  }
}

# Get order book depth
{
  priceLevels(where: { orderCount_gt: 0 }, orderBy: price) {
    price
    isBid
    totalQuantity
    orderCount
  }
}

# Get user's trade history
{
  user(id: "0x...") {
    trades {
      buyer {
        address
      }
      seller {
        address
      }
      price
      quantity
      timestamp
    }
  }
}
```
