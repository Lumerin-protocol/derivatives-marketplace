import { getAddress } from "viem";

/** Inlined into the client bundle via vite.config `define`; must match `ImportMetaEnv`. */

const ENV = {
  ETH_NODE_ADDRESS: validateUrl,
  COLLATERAL_TOKEN_ADDRESS: validateAddress,
  VAULT_ADDRESS: validateAddress,
  OPTION_REGISTRY_ADDRESS: validateAddress,
  OPTION_MARGIN_ENGINE_ADDRESS: validateAddress,
  OPTION_MATCHING_ROUTER_ADDRESS: validateAddress,
  DEFAULT_OPTIONS_SERIES_ID: validateSeriesId,
} as const;

export type ClientEnvKey = keyof typeof ENV;
export type ClientEnv = { [K in keyof typeof ENV]: ReturnType<(typeof ENV)[K]> };

export function validateEnv(raw: Record<string, string>): ClientEnv {
  const errors: string[] = [];
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const validator = ENV[key as ClientEnvKey];
    if (validator) {
      try {
        result[key] = validator(value);
      } catch (error) {
        errors.push(`Invalid value for ${key}: ${error}`);
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(`Invalid environment: ${errors.join(", ")}`);
  }
  return result as ClientEnv;
}

function validateAddress(v: string): `0x${string}` {
  return getAddress(v);
}

function validateUrl(v: string): URL {
  return new URL(v);
}

function validateSeriesId(v: string): bigint {
  if (!/^[0-9]+$/.test(v)) {
    throw new Error("Expected a numeric integer string for series id");
  }
  return BigInt(v);
}
