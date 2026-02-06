import { request } from "graphql-request";
import {
  PerpsStatsQuery,
  UserQuery,
  UserOrdersQuery,
  RecentTradesQuery,
  OrderBookQuery,
  OpenPositionsQuery,
} from "./subgraph-queries";

const SUBGRAPH_URL = process.env.SUBGRAPH_URL || "http://localhost:8000/subgraphs/name/perps";

async function testPerpsStats() {
  console.log("\n=== Perps Stats ===");
  const result = await request(SUBGRAPH_URL, PerpsStatsQuery);
  console.log(JSON.stringify(result, null, 2));
}

async function testUser(address: string) {
  console.log(`\n=== User ${address} ===`);
  const result = await request(SUBGRAPH_URL, UserQuery, { address });
  console.log(JSON.stringify(result, null, 2));
}

async function testUserOrders(address: string) {
  console.log(`\n=== User Orders ${address} ===`);
  const result = await request(SUBGRAPH_URL, UserOrdersQuery, {
    address,
    first: 10,
    skip: 0,
  });
  console.log(JSON.stringify(result, null, 2));
}

async function testRecentTrades() {
  console.log("\n=== Recent Trades ===");
  const result = await request(SUBGRAPH_URL, RecentTradesQuery, {
    first: 10,
    skip: 0,
  });
  console.log(JSON.stringify(result, null, 2));
}

async function testOrderBook() {
  console.log("\n=== Order Book ===");
  const result = await request(SUBGRAPH_URL, OrderBookQuery);
  console.log(JSON.stringify(result, null, 2));
}

async function testOpenPositions() {
  console.log("\n=== Open Positions ===");
  const result = await request(SUBGRAPH_URL, OpenPositionsQuery, {
    first: 10,
    skip: 0,
  });
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  try {
    await testPerpsStats();
    await testRecentTrades();
    await testOrderBook();
    await testOpenPositions();

    // Test with a specific user address if provided
    const userAddress = process.argv[2];
    if (userAddress) {
      await testUser(userAddress);
      await testUserOrders(userAddress);
    }
  } catch (error) {
    console.error("Error:", error);
  }
}

main();
