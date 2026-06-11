import { configVariable, defineConfig } from "hardhat/config";
import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";
import codegenPlugin from "./plugins/codegen/index.ts";
import { tryLoadEnvFile } from "./lib/env.ts";

tryLoadEnvFile("./../.env");
tryLoadEnvFile(".env");

export default defineConfig({
  plugins: [hardhatToolboxViem, codegenPlugin],
  codegen: {
    contracts: [
      "HashPowerPerpsDEX",
      "ICollateralVault",
      "IPortfolioMarginEngine",
      "IERC20",
      "IERC20Metadata",
      "IERC20Permit",
      "IERC5267",
      "UpgradeableBeacon",
      "ERC1967Proxy",
      "CollateralVault",
      "AggregatorV3Interface",
      "Multicall3",
      "PriceOracleMock",
      "USDCMock",
    ],
  },
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
      "collateral-margin/contracts/contracts/CollateralVault.sol",
      "collateral-margin/contracts/contracts/PortfolioMarginEngine.sol",
      "collateral-margin/contracts/contracts/Points.sol",
      "collateral-margin/contracts/contracts/PointsHook.sol",
      "collateral-margin/contracts/contracts/interfaces/ICollateralVault.sol",
      "collateral-margin/contracts/contracts/interfaces/IPointsHook.sol",
      "collateral-margin/contracts/contracts/interfaces/IPortfolioMarginEngine.sol",
      "collateral-margin/contracts/contracts/interfaces/IHashPowerPerpsDEX.sol",
      "collateral-margin/contracts/contracts/interfaces/IOptionsEnginePortfolioView.sol",
      "collateral-margin/contracts/contracts/mocks/PerpsDEXMock.sol",
      "collateral-margin/contracts/contracts/mocks/OptionsEngineMock.sol",
    ],
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },

  verify: {
    etherscan: {
      apiKey: configVariable("ETHERSCAN_API_KEY"),
      enabled: true,
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
    "base-sepolia": {
      type: "http",
      chainType: "l1",
      chainId: 84532,
      url: configVariable("ALCHEMY_API_KEY", "https://base-sepolia.g.alchemy.com/v2/{variable}"),
      accounts: [configVariable("PRIVATE_KEY")],
    },
    "base-mainnet": {
      type: "http",
      chainType: "l1",
      chainId: 8453,
      url: configVariable("ALCHEMY_API_KEY", "https://base-mainnet.g.alchemy.com/v2/{variable}"),
      accounts: [configVariable("PRIVATE_KEY")],
    },
  },
});
