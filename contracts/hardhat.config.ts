import { configVariable, defineConfig } from "hardhat/config";
import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";
import hardhatViemAbi from "hardhat-viem-abi";
import { tryLoadEnvFile } from "./lib/env.ts";

tryLoadEnvFile("./../.env");
tryLoadEnvFile(".env");

export default defineConfig({
  plugins: [hardhatToolboxViem, hardhatViemAbi],
  codegen: {
    // Keepers and the UI install `abi/` as this package name; do not rename casually.
    packageJson: { name: "derivatives-marketplace-abi" },
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
    // Default: viaIR for large impls (HashPowerPerpsDEX EIP-170 limit).
    compilers: [
      {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
          evmVersion: "cancun",
        },
      },
    ],
    // OZ ERC1967Proxy was deployed without viaIR; matching settings keep
    // artifacts verifiable on Basescan / Tenderly.
    overrides: {
      "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol": {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: false,
          evmVersion: "cancun",
        },
      },
    },
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
      "collateral-margin/contracts/contracts/interfaces/ILinearMarket.sol",
      "collateral-margin/contracts/contracts/interfaces/IOptionsEnginePortfolioView.sol",
      "collateral-margin/contracts/contracts/mocks/PerpsDEXMock.sol",
      "collateral-margin/contracts/contracts/mocks/OptionsEngineMock.sol",
    ],
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
