import { describe, it } from "node:test";
import assert from "node:assert";
import { request } from "graphql-request";
import {
  PerpsStatsQuery,
  UserQuery,
  UserOrdersQuery,
  RecentTradesQuery,
  OrderBookQuery,
  OpenPositionsQuery,
} from "./subgraph-queries.ts";

const SUBGRAPH_URL = process.env.SUBGRAPH_URL || "http://localhost:8000/subgraphs/name/perps";

describe("Subgraph smoke tests", () => {
  it("fetches perps stats", async () => {
    const result = await request(SUBGRAPH_URL, PerpsStatsQuery);
    assert.ok(result, "Perps stats should return data");
  });

  it("fetches recent trades", async () => {
    const result = await request(SUBGRAPH_URL, RecentTradesQuery, {
      first: 10,
      skip: 0,
    });
    assert.ok(result, "Recent trades should return data");
  });

  it("fetches order book", async () => {
    const result = await request(SUBGRAPH_URL, OrderBookQuery);
    assert.ok(result, "Order book should return data");
  });

  it("fetches open positions", async () => {
    const result = await request(SUBGRAPH_URL, OpenPositionsQuery, {
      first: 10,
      skip: 0,
    });
    assert.ok(result, "Open positions should return data");
  });
});

const userAddress = process.argv[2];
if (userAddress) {
  describe("User-specific smoke tests", () => {
    it(`fetches user ${userAddress}`, async () => {
      const result = await request(SUBGRAPH_URL, UserQuery, { address: userAddress });
      assert.ok(result, "User query should return data");
    });

    it(`fetches orders for user ${userAddress}`, async () => {
      const result = await request(SUBGRAPH_URL, UserOrdersQuery, {
        address: userAddress,
        first: 10,
        skip: 0,
      });
      assert.ok(result, "User orders should return data");
    });
  });
}
