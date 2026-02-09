import type { Address, Hex } from "viem";
import type pino from "pino";

export interface Config {
  network: string;
  ethNodeAddress: string;
  perpsAddress: Address;
  keeperPrivateKey: Hex;
  ethPriceFeedAddress?: Address;
  pollIntervalMs: number;
  resyncIntervalMs: number;
  dryRun: boolean;
  minProfitMargin: bigint;
  healthPort: number;
  logLevel: pino.Level;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): Config {
  const cfg = {
    ethNodeAddress: requireEnv("ETH_NODE_ADDRESS"),
    perpsAddress: requireEnv("PERPS_ADDRESS") as Address,
    keeperPrivateKey: requireEnv("KEEPER_PRIVATE_KEY") as Hex,
    ethPriceFeedAddress: process.env.ETH_PRICE_FEED_ADDRESS as Address | undefined,
    pollIntervalMs: Number(process.env.KEEPER_POLL_INTERVAL_MS ?? "5000"),
    resyncIntervalMs: Number(process.env.KEEPER_RESYNC_INTERVAL_MS ?? "300000"),
    dryRun: process.env.KEEPER_DRY_RUN === "true",
    minProfitMargin: BigInt(process.env.KEEPER_MIN_PROFIT_MARGIN ?? "0"),
    healthPort: Number(process.env.KEEPER_HEALTH_PORT ?? "3000"),
    network: requireEnv("NETWORK"),
    logLevel: (process.env.KEEPER_LOG_LEVEL as pino.Level) || "info",
  };
  return cfg;
}
