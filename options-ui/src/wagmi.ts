import { createConfig, http } from "wagmi";
import { hardhat } from "wagmi/chains";
import { injected } from "wagmi/connectors";

export const config = createConfig({
  chains: [hardhat],
  connectors: [injected()],
  transports: {
    [hardhat.id]: http(import.meta.env.ETH_NODE_ADDRESS.toString()),
  },
});
