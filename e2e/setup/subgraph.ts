import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { waitFor } from "../../contracts/fixtures/helpers.ts";

const INDEXER_DIR = resolve(import.meta.dirname, "../../indexer");
const TEMPLATE_PATH = resolve(INDEXER_DIR, "subgraph.template.yaml");
const SUBGRAPH_YAML_PATH = resolve(INDEXER_DIR, "subgraph.yaml");

const HARDHAT_RPC_URL = "http://localhost:8545";
const GRAPH_ADMIN_URL = "http://localhost:8020";
const GRAPH_QUERY_URL = "http://localhost:8000/subgraphs/name/perps";

// ── Stack readiness check ─────────────────────────────────────────────────────

export async function waitForStack(timeoutMs = 30_000): Promise<void> {
  console.log(`[stack] Waiting for Hardhat at ${HARDHAT_RPC_URL}...`);
  const hardhatReady = waitFor(
    async () => {
      try {
        const res = await fetch(HARDHAT_RPC_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
    timeoutMs,
    2_000,
  );

  console.log(`[stack] Waiting for graph-node admin at ${GRAPH_ADMIN_URL}...`);
  const graphReady = waitFor(
    async () => {
      try {
        const res = await fetch(GRAPH_ADMIN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "subgraph_list", params: [], id: 1 }),
        });
        return res.status === 200;
      } catch {
        return false;
      }
    },
    timeoutMs,
    2_000,
  );

  await Promise.all([hardhatReady, graphReady]);
  console.log("[stack] All services reachable.");
}

// ── Subgraph deploy ───────────────────────────────────────────────────────────

export async function deploySubgraph(perpsAddress: string, startBlock: number): Promise<void> {
  const log = (msg: string) => console.log(`[subgraph] ${msg}`);

  const run = (label: string, cmd: string) => {
    log(label);
    try {
      execSync(cmd, { cwd: INDEXER_DIR, stdio: "inherit" });
    } catch (err) {
      throw new Error(`${label} failed: ${(err as Error).message}`);
    }
  };

  log(`Generating subgraph.yaml (address=${perpsAddress}, startBlock=${startBlock})...`);
  const template = readFileSync(TEMPLATE_PATH, "utf-8");
  const yaml = template
    .replaceAll("${NETWORK}", "hardhat")
    .replaceAll("${PERPS_ADDRESS}", perpsAddress)
    .replaceAll("${PERPS_START_BLOCK}", String(startBlock));
  writeFileSync(SUBGRAPH_YAML_PATH, yaml);
  log("subgraph.yaml written.");

  // Wipe the build cache so graph build always uses the freshly generated
  // subgraph.yaml. Without this, a stale ./build/ from a previous run
  // (e.g. with network: arbitrum-sepolia) gets re-uploaded as-is.
  run("Cleaning stale build artifacts...", "rm -rf build generated");

  run("Running graph codegen...", "pnpm exec graph codegen");

  // Remove any leftover subgraph so the new deployment starts with a clean index.
  log("Removing old subgraph (if any)...");
  try {
    execSync("pnpm exec graph remove --node http://localhost:8020/ perps", {
      cwd: INDEXER_DIR,
      stdio: "pipe",
    });
    log("Old subgraph removed.");
  } catch {
    log("No existing subgraph to remove.");
  }

  log("Creating subgraph on local node...");
  await waitFor(
    () => {
      try {
        execSync("pnpm exec graph create --node http://localhost:8020/ perps", {
          cwd: INDEXER_DIR,
          stdio: "pipe",
        });
        return Promise.resolve(true);
      } catch (err) {
        log(`Create attempt failed (${(err as Error).message.split("\n")[0]}), retrying...`);
        return Promise.resolve(false);
      }
    },
    60_000,
    2_000,
  );

  log("Deploying subgraph (with retries)...");
  await waitFor(
    () => {
      try {
        execSync(
          "pnpm exec graph deploy --node http://localhost:8020/ --ipfs http://localhost:5001 --version-label 0 perps",
          { cwd: INDEXER_DIR, stdio: "inherit" },
        );
        return Promise.resolve(true);
      } catch (err) {
        log(`Deploy attempt failed (${(err as Error).message.split("\n")[0]}), retrying...`);
        return Promise.resolve(false);
      }
    },
    60_000,
    3_000,
  );
  log("Subgraph deployed.");

  log("Waiting for subgraph to start indexing...");
  await waitFor(
    async () => {
      try {
        const res = await fetch(GRAPH_QUERY_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: "{ _meta { block { number } } }" }),
        });
        const { data } = (await res.json()) as { data?: { _meta?: unknown } };
        return !!data?._meta;
      } catch {
        return false;
      }
    },
    60_000,
    2_000,
  );
  log("Subgraph is indexing.");
}

export const SUBGRAPH_URL = GRAPH_QUERY_URL;
