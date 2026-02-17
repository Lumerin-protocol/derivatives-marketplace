import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  createTestClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "../src/config.ts";
import { hardhat } from "../src/client.ts";

// ── Well-known Hardhat accounts ──────────────────────────────────────────────

export const HARDHAT_ACCOUNTS = [
  {
    address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address,
    privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex,
  },
  {
    address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address,
    privateKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex,
  },
  {
    address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address,
    privateKey: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex,
  },
  {
    address: "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as Address,
    privateKey: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" as Hex,
  },
] as const;

export const RPC_URL = "http://127.0.0.1:8545";

// ── Hardhat node lifecycle ───────────────────────────────────────────────────

export interface HardhatNode {
  process: ChildProcess;
  stop: () => void;
}

export async function startHardhatNode(): Promise<HardhatNode> {
  const contractsDir = resolve(import.meta.dirname, "../../contracts");

  const proc = spawn("npx", ["hardhat", "node"], {
    cwd: contractsDir,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Wait for the node to be ready by polling the RPC endpoint
  await waitFor(async () => {
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }, 30_000);

  return {
    process: proc,
    stop() {
      proc.kill("SIGTERM");
    },
  };
}

// ── Viem clients ─────────────────────────────────────────────────────────────

const transport = http(RPC_URL);

export function createTestPublicClient() {
  return createPublicClient({ transport, chain: hardhat, pollingInterval: 100 });
}

export function createTestWalletClient(privateKey: Hex) {
  const account = privateKeyToAccount(privateKey);
  return createWalletClient({ account, transport, chain: hardhat });
}

export function createTestClientInstance() {
  return createTestClient({ transport, chain: hardhat, mode: "hardhat" });
}

// ── Keeper config builder ────────────────────────────────────────────────────

export function createKeeperConfig(perpsAddress: Address): Config {
  return {
    network: "hardhat",
    ethNodeAddress: RPC_URL,
    perpsAddress,
    keeperPrivateKey: HARDHAT_ACCOUNTS[3].privateKey,
    pollIntervalMs: 200,
    resyncIntervalMs: 60_000,
    dryRun: false,
    minProfitMargin: 0n,
    healthPort: 0, // disabled in tests
    logLevel: "silent" as Config["logLevel"],
  };
}

// ── Utilities ────────────────────────────────────────────────────────────────

export async function waitFor(
  fn: () => Promise<boolean> | boolean,
  timeoutMs = 10_000,
  intervalMs = 100,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const fixtureCache = new Map<() => Promise<unknown>, { result: unknown; snapshotId: Hex }>();

export async function loadFixture<T>(fixture: () => Promise<T>): Promise<T> {
  const cached = fixtureCache.get(fixture as () => Promise<unknown>);
  const tc = createTestClientInstance();

  if (cached) {
    // Restore to the snapshot taken right after the fixture ran.
    // revert() consumes the snapshot, so we immediately take a new one.
    await tc.revert({ id: cached.snapshotId });
    cached.snapshotId = await tc.snapshot();
    return cached.result as T;
  }

  // First call — actually run the fixture, then snapshot
  const result = await fixture();
  const snapshotId = await tc.snapshot();
  fixtureCache.set(fixture as () => Promise<unknown>, { result, snapshotId });
  return result;
}
