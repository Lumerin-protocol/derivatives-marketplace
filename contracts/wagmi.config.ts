import { defineConfig } from "@wagmi/cli";
import { hardhat } from "@wagmi/cli/plugins";

export default defineConfig({
  plugins: [
    hardhat({
      artifacts: "./artifacts/contracts",
      project: ".",
      commands: {
        build: "pnpm hardhat compile",
        rebuild: "pnpm hardhat compile",
      },
    }),
    hardhat({
      artifacts: "./artifacts/@openzeppelin/contracts/token/ERC20/IERC20.sol",
      project: ".",
      commands: {
        build: "pnpm hardhat compile",
        rebuild: "pnpm hardhat compile",
      },
    }),
    hardhat({
      artifacts: "./artifacts/@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol",
      project: ".",
      commands: {
        build: "pnpm hardhat compile",
        rebuild: "pnpm hardhat compile",
      },
    }),
    hardhat({
      artifacts: "./artifacts/@openzeppelin/contracts/interfaces/IERC5267.sol",
      project: ".",
      commands: {
        build: "pnpm hardhat compile",
        rebuild: "pnpm hardhat compile",
      },
    }),
  ],
  out: "./abi/abi.ts",
});
