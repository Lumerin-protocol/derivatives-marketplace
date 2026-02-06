import { gql } from "graphql-request";

// Get contract stats
export const PerpsStatsQuery = gql`
  query PerpsStats {
    perps(id: 0) {
      contractAddress
      collateralToken
      priceOracle
      marginPercent
      maintenanceMarginPercent
      liquidationFee
      minimumPriceIncrement
      orderFee
      reservePoolBalance
      collectedFeesBalance
      totalUsers
      totalOrders
      activeOrders
      totalTrades
      totalVolume
      totalLiquidations
      initializedAt
      lastUpdatedAt
    }
  }
`;

// Get user details with orders and positions
export const UserQuery = gql`
  query User($address: ID!) {
    user(id: $address) {
      address
      collateralBalance
      totalDeposited
      totalWithdrawn
      netQuantity
      aggregatedEntryPrice
      orderCount
      activeOrderCount
      tradeCount
      realizedPnl
      createdAt
      lastActivityAt
    }
  }
`;

// Get user's active orders
export const UserOrdersQuery = gql`
  query UserOrders($address: ID!, $first: Int!, $skip: Int!) {
    user(id: $address) {
      orders(
        first: $first
        skip: $skip
        orderBy: createdAt
        orderDirection: desc
        where: { status: "ACTIVE" }
      ) {
        id
        price
        quantity
        originalQuantity
        isBuy
        status
        filledQuantity
        createdAt
      }
    }
  }
`;

// Get user's trades
export const UserTradesQuery = gql`
  query UserTrades($address: ID!, $first: Int!, $skip: Int!) {
    user(id: $address) {
      trades(first: $first, skip: $skip, orderBy: timestamp, orderDirection: desc) {
        id
        makerOrderId
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
  }
`;

// Get user's position history
export const UserPositionHistoryQuery = gql`
  query UserPositionHistory($address: ID!, $first: Int!, $skip: Int!) {
    user(id: $address) {
      positionHistory(first: $first, skip: $skip, orderBy: timestamp, orderDirection: desc) {
        id
        tradePrice
        tradeQuantity
        netQuantityAfter
        aggregatedEntryPriceAfter
        timestamp
      }
    }
  }
`;

// Get recent trades
export const RecentTradesQuery = gql`
  query RecentTrades($first: Int!, $skip: Int!) {
    trades(first: $first, skip: $skip, orderBy: timestamp, orderDirection: desc) {
      id
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
      blockNumber
      transactionHash
    }
  }
`;

// Get order book (price levels)
export const OrderBookQuery = gql`
  query OrderBook {
    priceLevels(where: { orderCount_gt: 0 }, orderBy: price, orderDirection: desc) {
      id
      price
      isBid
      totalQuantity
      orderCount
    }
  }
`;

// Get active orders at a price level
export const OrdersAtPriceQuery = gql`
  query OrdersAtPrice($price: BigInt!, $isBuy: Boolean!, $first: Int!) {
    orders(
      where: { price: $price, isBuy: $isBuy, status: "ACTIVE" }
      first: $first
      orderBy: createdAt
      orderDirection: asc
    ) {
      id
      user {
        address
      }
      quantity
      createdAt
    }
  }
`;

// Get recent liquidations
export const RecentLiquidationsQuery = gql`
  query RecentLiquidations($first: Int!, $skip: Int!) {
    liquidations(first: $first, skip: $skip, orderBy: timestamp, orderDirection: desc) {
      id
      user {
        address
      }
      liquidator {
        address
      }
      positionSize
      pnl
      liquidatorFee
      timestamp
    }
  }
`;

// Get top traders by realized PnL
export const TopTradersQuery = gql`
  query TopTraders($first: Int!) {
    users(first: $first, orderBy: realizedPnl, orderDirection: desc, where: { tradeCount_gt: 0 }) {
      address
      realizedPnl
      tradeCount
      netQuantity
      collateralBalance
    }
  }
`;

// Get users with open positions
export const OpenPositionsQuery = gql`
  query OpenPositions($first: Int!, $skip: Int!) {
    users(
      first: $first
      skip: $skip
      where: { netQuantity_not: 0 }
      orderBy: lastActivityAt
      orderDirection: desc
    ) {
      address
      netQuantity
      aggregatedEntryPrice
      collateralBalance
      realizedPnl
    }
  }
`;
