import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { request, gql } from "graphql-request";

import { waitFor } from "../../contracts/fixtures/helpers.ts";
import { waitForStack, deploySubgraph, SUBGRAPH_URL } from "../setup/subgraph.ts";
import { deployWithLiquidatablePositionFixture } from "../../contracts/fixtures/viem.ts";

// ── Shared state ──────────────────────────────────────────────────────────────

let deployment: Awaited<ReturnType<typeof deployWithLiquidatablePositionFixture>>;

// ── Lifecycle ─────────────────────────────────────────────────────────────────
// Docker stack (hardhat, graph-node, ipfs, postgres) must already be running:
//   cd e2e && docker compose up -d

before(
  async () => {
    console.log("[e2e] Waiting for Docker stack to be reachable...");
    // Cold CI pulls (graph-node/postgres/ipfs + hardhat image build) can exceed 30s.
    await waitForStack(180_000);

    console.log("[e2e] Deploying contracts...");
    deployment = await deployWithLiquidatablePositionFixture();

    const { perpsAddress } = deployment.contracts;

    console.log("[e2e] Deploying subgraph...");
    await deploySubgraph(perpsAddress, Number(deployment.config.startBlock));

    console.log("[e2e] Setup complete.");
  },
  { timeout: 180_000 },
);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Deployment", () => {
  it("deploys the contracts", { timeout: 40_000 }, async (t) => {
    const qd = await deployment.contracts.perps.read.QUANTITY_DECIMALS();
    console.log(qd);
  });
});

describe("Subgraph indexing", () => {
  it("indexes the HashPowerPerpsDEX contract on deployment", { timeout: 40_000 }, async (t) => {
    console.log("Waiting for perps entity to appear in subgraph...");

    const data = await pollSubgraph<{ perps: { contractAddress: string } | null }>(
      PerpsStatsQuery,
      {},
      (d) => d.perps !== null,
    );

    console.log(data);

    assert.ok(data.perps, "perps entity should exist");
    assert.equal(
      data.perps.contractAddress.toLowerCase(),
      deployment.contracts.perpsAddress.toLowerCase(),
      "contract address should match",
    );
  });

  it("indexes OrderCreated events", { timeout: 40_000 }, async (t) => {
    const { clients } = deployment;
    const address = clients.sellerWallet.account.address.toLowerCase();

    console.log(`Waiting for orders by ${address} to appear in subgraph...`);

    // The fixture already created orders — poll until subgraph indexes them
    const data = await pollSubgraph<{ user: { orderCount: string } | null }>(
      OrdersQuery,
      { address },
      (d) => Number(d.user?.orderCount ?? 0) > 0,
    );

    assert.ok(data.user, "user entity should exist after creating an order");
    assert.ok(Number(data.user.orderCount) > 0, "seller should have at least one order");
  });

  it("indexes OrderMatched events and creates positions", { timeout: 40_000 }, async (t) => {
    const { clients } = deployment;
    const sellerAddress = clients.sellerWallet.account.address.toLowerCase();

    console.log("Waiting for seller position to appear in subgraph...");

    // The fixture matched orders, so the seller has a short position
    const data = await pollSubgraph<{ user: { netQuantity: string } | null }>(
      PositionQuery,
      { address: sellerAddress },
      (d) => d.user !== null && d.user.netQuantity !== "0",
    );

    assert.ok(data.user, "seller user entity should exist");
    assert.ok(BigInt(data.user.netQuantity) < 0n, "seller should be short (negative net qty)");
  });
});

// ── Queries ───────────────────────────────────────────────────────────────────

const PerpsStatsQuery = gql`
  query {
    perps(id: 0) {
      contractAddress
      totalOrders
      totalTrades
      totalLiquidations
    }
  }
`;

const OrdersQuery = gql`
  query ($address: ID!) {
    user(id: $address) {
      orderCount
      activeOrderCount
    }
  }
`;

const PositionQuery = gql`
  query ($address: ID!) {
    user(id: $address) {
      netQuantity
    }
  }
`;

// ── Helper ────────────────────────────────────────────────────────────────────

async function pollSubgraph<T>(
  query: string,
  variables: Record<string, unknown>,
  check: (data: T) => boolean,
  timeoutMs = 30_000,
): Promise<T> {
  let last: T | undefined;
  await waitFor(
    async () => {
      try {
        last = await request<T>(SUBGRAPH_URL, query, variables);
        return check(last);
      } catch {
        return false;
      }
    },
    timeoutMs,
    2_000,
  );
  return last!;
}
