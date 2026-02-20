export {
  HARDHAT_ACCOUNTS,
  RPC_URL,
  hardhat,
  startHardhatNode,
  waitFor,
  sleep,
  loadFixture,
  createTestPublicClient,
  createTestWalletClient,
  createTestClientInstance,
  type HardhatNode,
} from "../../contracts/fixtures/helpers.ts";

import type { Address } from "viem";
import type { Config } from "../src/config.ts";
import { HARDHAT_ACCOUNTS, RPC_URL } from "../../contracts/fixtures/helpers.ts";

export function createKeeperConfig(perpsAddress: Address): Config {
  return {
    network: "hardhat",
    ethNodeAddress: RPC_URL,
    perpsAddress,
    keeperPrivateKey: HARDHAT_ACCOUNTS[3].privateKey,
    pollIntervalMs: 200,
    resyncIntervalMs: 60_000,
    dryRun: false,
    minProfitMargin: 0n,
    healthPort: 0,
    logLevel: "silent" as Config["logLevel"],
  };
}
