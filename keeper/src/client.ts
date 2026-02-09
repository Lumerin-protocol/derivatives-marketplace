import { createPublicClient, createWalletClient, http, webSocket } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "./config.ts";
import { arbitrum, arbitrumSepolia } from "viem/chains";

const chainMapping = {
  "arbitrum-sepolia": arbitrumSepolia,
  arbitrum: arbitrum,
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
