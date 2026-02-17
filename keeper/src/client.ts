import { createPublicClient, createWalletClient, http, webSocket, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "./config.ts";
import { arbitrum, arbitrumSepolia, hardhat as hardhatBase } from "viem/chains";

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
  arbitrum: arbitrum,
  hardhat: hardhat,
} as const;

export function createClients(config: Config) {
  const chain = chainMapping[config.network as keyof typeof chainMapping];
  if (!chain) {
    throw new Error(`Unsupported network: ${config.network}`);
  }
  const transport = config.ethNodeAddress.startsWith("ws")
    ? webSocket(config.ethNodeAddress)
    : http(config.ethNodeAddress);

  const publicClient = createPublicClient({ transport, chain });
  const account = privateKeyToAccount(config.keeperPrivateKey);
  const walletClient = createWalletClient({ account, transport, chain });

  return { publicClient, walletClient, account };
}
