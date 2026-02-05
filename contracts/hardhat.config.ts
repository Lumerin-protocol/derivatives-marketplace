import type { HardhatUserConfig } from "hardhat/config";

import "solidity-coverage";
import "@nomiclabs/hardhat-ethers";
import "@nomicfoundation/hardhat-verify";
import "@openzeppelin/hardhat-upgrades";
import "hardhat-abi-exporter";
import "dotenv/config";
import "@nomicfoundation/hardhat-viem";
import "hardhat-storage-layout";
import "hardhat-gas-reporter";

import chai from "chai";
import chaiAsPromised from "chai-as-promised";

chai.use(chaiAsPromised);

// Base config is used for local deployment and/or contract build
const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.30",
        settings: {
          // viaIR: true,
          optimizer: {
            enabled: true,
            runs: 200,
            // details: {
            //   yulDetails: {
            //     optimizerSteps: "u",
            //   },
            // },
          },
        },
      },
    ],
  },
  networks: {
    hardhat: {
      mining: {
        auto: true,
      },
      initialDate: "2025-11-23",
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      accounts: [
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
        "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
        "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
        "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
      ],
      gasPrice: "auto",
      gas: "auto",
    },
  },
  abiExporter: {
    path: "./abi",
    runOnCompile: true,
    clear: true,
    flat: true,
    spacing: 2,
    only: [
      "@openzeppelin/contracts/token/ERC20/IERC20",
      "MulticallEmbedded",
      "multicall/Multicall3",
      "AggregatorV3Interface",
      "Multicall3",
      "HashrateOracle",
      "Futures",
      "BTCPriceOracleMock",
    ],
  },
  mocha: {},
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    gasPrice: 1,
    outputFile: "gas-report.md",
    reportPureAndViewMethods: true,
    reportFormat: "markdown",
  },
};

export default config;
