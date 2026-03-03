import type { Address, Hex } from "viem";
import type pino from "pino";

export interface MakerConfig {
  // Connection
  network: string;
  ethNodeAddress: string;
  perpsAddress: Address;
  makerPrivateKey: Hex;

  // Quoting
  numLevelsPerSide: number;
  baseQuantity: bigint;
  minSpreadBps: number;
  volatilityMultiplier: number;
  inventorySkewGamma: number;
  maxSkewTicks: number;

  // Gas management
  ethPriceFeedAddress?: Address;
  gasSpikeThresholdPct: number;
  gasCapMultiplier: number;
  gasPenaltyBps: number;
  maxGasBudgetPerHourUsd: bigint;
  maxGasBudgetPerDayUsd: bigint;
  urgentRequoteThresholdTicks: number;

  // Risk
  maxPositionSize: bigint;
  maxUtilizationPct: number;
  minCollateralBalance: bigint;
  maxDailyLossUsd: bigint;

  // Timing
  pollIntervalMs: number;
  requoteThresholdTicks: number;
  requoteCooldownMs: number;
  resyncIntervalMs: number;

  // Operational
  dryRun: boolean;
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

export function loadConfig(): MakerConfig {
  return {
    network: requireEnv("NETWORK"),
    ethNodeAddress: requireEnv("ETH_NODE_ADDRESS"),
    perpsAddress: requireEnv("PERPS_ADDRESS") as Address,
    makerPrivateKey: requireEnv("MAKER_PRIVATE_KEY") as Hex,

    numLevelsPerSide: Number(process.env.MAKER_LEVELS_PER_SIDE ?? "5"),
    baseQuantity: BigInt(process.env.MAKER_BASE_QUANTITY ?? "1000000"),
    minSpreadBps: Number(process.env.MAKER_MIN_SPREAD_BPS ?? "10"),
    volatilityMultiplier: Number(process.env.MAKER_VOLATILITY_MULTIPLIER ?? "2.0"),
    inventorySkewGamma: Number(process.env.MAKER_INVENTORY_SKEW_GAMMA ?? "0.5"),
    maxSkewTicks: Number(process.env.MAKER_MAX_SKEW_TICKS ?? "20"),

    ethPriceFeedAddress: process.env.ETH_PRICE_FEED_ADDRESS as Address | undefined,
    gasSpikeThresholdPct: Number(process.env.MAKER_GAS_SPIKE_THRESHOLD_PCT ?? "200"),
    gasCapMultiplier: Number(process.env.MAKER_GAS_CAP_MULTIPLIER ?? "2.0"),
    gasPenaltyBps: Number(process.env.MAKER_GAS_PENALTY_BPS ?? "5"),
    maxGasBudgetPerHourUsd: BigInt(process.env.MAKER_MAX_GAS_BUDGET_HOUR_USD ?? "50000000"),
    maxGasBudgetPerDayUsd: BigInt(process.env.MAKER_MAX_GAS_BUDGET_DAY_USD ?? "500000000"),
    urgentRequoteThresholdTicks: Number(process.env.MAKER_URGENT_REQUOTE_TICKS ?? "10"),

    maxPositionSize: BigInt(process.env.MAKER_MAX_POSITION_SIZE ?? "100000000"),
    maxUtilizationPct: Number(process.env.MAKER_MAX_UTILIZATION_PCT ?? "80"),
    minCollateralBalance: BigInt(process.env.MAKER_MIN_COLLATERAL ?? "100000000"),
    maxDailyLossUsd: BigInt(process.env.MAKER_MAX_DAILY_LOSS_USD ?? "1000000000"),

    pollIntervalMs: Number(process.env.MAKER_POLL_INTERVAL_MS ?? "3000"),
    requoteThresholdTicks: Number(process.env.MAKER_REQUOTE_THRESHOLD_TICKS ?? "2"),
    requoteCooldownMs: Number(process.env.MAKER_REQUOTE_COOLDOWN_MS ?? "1000"),
    resyncIntervalMs: Number(process.env.MAKER_RESYNC_INTERVAL_MS ?? "60000"),

    dryRun: process.env.MAKER_DRY_RUN === "true",
    healthPort: Number(process.env.MAKER_HEALTH_PORT ?? "3001"),
    logLevel: (process.env.MAKER_LOG_LEVEL as pino.Level) || "info",
  };
}
