import base from "./hardhat.config.ts";
import type { HardhatUserConfig } from "hardhat/config";

if (!process.env.ETH_NODE_ADDRESS) {
  throw new Error("ETH_NODE_ADDRESS env variable is not set");
}

const config: HardhatUserConfig = {
  ...base,
  networks: {
    ...base.networks,
    production: {
      type: "http",
      url: process.env.ETH_NODE_ADDRESS,
      accounts: [
        process.env.DEPLOYER_PRIVATEKEY!,
        // ...(process.env.PROPOSER_PRIVATEKEY ? [process.env.PROPOSER_PRIVATEKEY] : []),
      ],
      gasPrice: "auto",
      gas: "auto",
    },
  },
  verify: {
    etherscan: {
      apiKey: process.env.ETHERSCAN_API_KEY!,
      enabled: true,
    },
  },
};

export default config;
