import { defineConfig } from "hardhat/config";
import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";
import dotenv from "dotenv";
dotenv.config({ path: "../.env" });

export default defineConfig({
  plugins: [hardhatToolboxViem],
  paths: {
    tests: "tests",
  },
  solidity: {
    version: "0.8.28",
    npmFilesToBuild: [
      "@openzeppelin/contracts/token/ERC20/IERC20.sol",
      "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol",
      "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol",
      "@openzeppelin/contracts/interfaces/IERC5267.sol",
      "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol",
      "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol",
      "hashprice-oracle/contracts/contracts/BTCPriceOracleMock.sol",
    ],
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: {
      type: "edr-simulated",
      mining: {
        auto: true,
      },
    },
    localhost: {
      type: "http",
      url: "http://127.0.0.1:8545",
    },
  },
});
