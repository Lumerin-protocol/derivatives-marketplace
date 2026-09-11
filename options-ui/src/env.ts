import { getAddress } from "viem";

/** Inlined into the client bundle via vite.config `define`; must match `ImportMetaEnv`. */

const ENV = {
  /** Normalized RPC URL string (not `URL`) so Vite `define` can inline a JSON string in production builds. */
  ETH_NODE_ADDRESS: validateRpcUrlString,
  COLLATERAL_TOKEN_ADDRESS: validateAddress,
  VAULT_ADDRESS: validateAddress,
  OPTION_REGISTRY_ADDRESS: validateAddress,
  OPTION_MARGIN_ENGINE_ADDRESS: validateAddress,
  OPTION_MATCHING_ROUTER_ADDRESS: validateAddress,
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
  for (const key of Object.keys(ENV) as ClientEnvKey[]) {
    if (!(key in result)) {
      errors.push(`Missing required env: ${key}`);
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

function validateRpcUrlString(v: string): string {
  return new URL(v).href;
}
