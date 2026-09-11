import { gql } from "graphql-request";

// Get contract stats
export const PerpsStatsQuery = gql`
  query PerpsStats {
    perps(id: 0) {
      contractAddress
      collateralVault
      priceOracle
      portfolioMargin
      liquidationFeeBps
      liquidatorShareBps
      minimumPriceIncrement
      takerFeeBps
      makerFeeBps
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

// Get user's trades (position updates from PositionTrade events)
export const UserTradesQuery = gql`
  query UserTrades($address: ID!, $first: Int!, $skip: Int!) {
    user(id: $address) {
      trades(first: $first, skip: $skip, orderBy: timestamp, orderDirection: desc) {
        id
        tradePrice
        tradeQuantity
        netQuantityAfter
        aggregatedEntryPriceAfter
        realizedPnl
        timestamp
      }
    }
  }
`;

// Get recent trades (each row = one user's side of a match)
export const RecentTradesQuery = gql`
  query RecentTrades($first: Int!, $skip: Int!) {
    trades(first: $first, skip: $skip, orderBy: timestamp, orderDirection: desc) {
      id
      user {
        address
      }
      tradePrice
      tradeQuantity
      netQuantityAfter
      realizedPnl
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

// Per-user / global liquidation lists now ride the flagged Trade feed, e.g.
// `trades(where: { isLiquidation: true })` / `trades(where: { liquidator: $addr })`,
// since the dedicated Liquidation entity was dropped (superseded by the Trade).

// Get top traders by realized PnL
export const TopTradersQuery = gql`
  query TopTraders($first: Int!) {
    users(first: $first, orderBy: realizedPnl, orderDirection: desc, where: { tradeCount_gt: 0 }) {
      address
      realizedPnl
      tradeCount
      netQuantity
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
      realizedPnl
    }
  }
`;
