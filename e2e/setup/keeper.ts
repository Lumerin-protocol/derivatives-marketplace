import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { HARDHAT_ACCOUNTS, RPC_URL, waitFor } from "../../contracts/fixtures/helpers.ts";

const KEEPER_DIR = resolve(import.meta.dirname, "../../keeper");
export const KEEPER_HEALTH_PORT = 3001;

export interface KeeperProcess {
  process: ChildProcess;
  stop(): Promise<void>;
}

export async function startKeeper(perpsAddress: string): Promise<KeeperProcess> {
  const proc = spawn("pnpm", ["dev"], {
    cwd: KEEPER_DIR,
    detached: true,
    env: {
      ...process.env,
      NETWORK: "hardhat",
      ETH_NODE_ADDRESS: RPC_URL,
      PERPS_ADDRESS: perpsAddress,
      KEEPER_PRIVATE_KEY: HARDHAT_ACCOUNTS[3].privateKey,
      KEEPER_POLL_INTERVAL_MS: "1000",
      KEEPER_RESYNC_INTERVAL_MS: "60000",
      KEEPER_LOG_LEVEL: "info",
      KEEPER_DRY_RUN: "false",
      KEEPER_HEALTH_PORT: String(KEEPER_HEALTH_PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout?.pipe(process.stdout);
  proc.stderr?.pipe(process.stderr);

  await waitFor(
    async () => {
      try {
        const res = await fetch(`http://localhost:${KEEPER_HEALTH_PORT}/health`);
        return res.ok;
      } catch {
        return false;
      }
    },
    20_000,
    500,
  );

  return {
    process: proc,
    stop() {
      return new Promise<void>((resolve) => {
        proc.stderr?.unpipe(process.stderr);
        proc.once("close", () => resolve());
        process.kill(-proc.pid!, "SIGTERM");
      });
    },
  };
}
