import {
  createPublicClient,
  createWalletClient,
  http,
  webSocket,
  defineChain,
  getContract,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { MakerConfig } from "./config.ts";
import {
  arbitrum,
  arbitrumSepolia,
  base,
  baseSepolia,
  hardhat as hardhatBase,
} from "viem/chains";

export { getContract };

// ── Test client helpers ─────────────────────────────────────────────────────

const testTransport = http("http://127.0.0.1:8545");

export function createTestPublicClient() {
  return createPublicClient({
    transport: testTransport,
    chain: hardhat,
    pollingInterval: 100,
  });
}

export const hardhat = defineChain({
  ...hardhatBase,
  contracts: {
    ...hardhatBase.contracts,
    multicall3: {
      address: "0xcA11bde05977b3631167028862bE2a173976CA11" as `0x${string}`,
    },
  },
});

export const chainMapping = {
  "arbitrum-sepolia": arbitrumSepolia,
  "base-sepolia": baseSepolia,
  arbitrum: arbitrum,
  base: base,
  hardhat: hardhat,
} as const;

export function createClients(config: MakerConfig) {
  const chain = chainMapping[config.network as keyof typeof chainMapping];
  if (!chain) {
    throw new Error(`Unsupported network: ${config.network}`);
  }
  const transport = config.ethNodeAddress.startsWith("ws")
    ? webSocket(config.ethNodeAddress)
    : http(config.ethNodeAddress);

  const publicClient = createPublicClient({ transport, chain });
  const account = privateKeyToAccount(config.makerPrivateKey);
  const walletClient = createWalletClient({ account, transport, chain });

  return { publicClient, walletClient, account, chain };
}

export type PublicClient = ReturnType<typeof createClients>["publicClient"];
export type WalletClient = ReturnType<typeof createClients>["walletClient"];
export type Account = ReturnType<typeof createClients>["account"];
export type Chain = ReturnType<typeof createClients>["chain"];
