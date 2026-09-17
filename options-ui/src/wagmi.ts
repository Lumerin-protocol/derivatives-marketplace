import { createConfig, http } from "wagmi";
import { hardhat as hardhatBase } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import { defineChain } from "viem";

/** Only chain this UI supports (local Hardhat / 31337). Multicall3 pre-deployed at canonical address (see deploy-local fixture). */
export const targetChain = defineChain({
  ...hardhatBase,
  contracts: {
    ...hardhatBase.contracts,
    multicall3: {
      address: "0xcA11bde05977b3631167028862bE2a173976CA11",
    },
  },
});

export const config = createConfig({
  chains: [targetChain],
  connectors: [injected()],
  transports: {
    [targetChain.id]: http(import.meta.env.ETH_NODE_ADDRESS),
  },
});
