import {
  verifyContract as hreVerify,
  type VerifyContractArgs,
} from "@nomicfoundation/hardhat-verify/verify";
import hre from "hardhat";
import { getAddress, isAddress } from "viem";

/// Providers we attempt by default. Independent indexers — verifying on more
/// than one is fine, and a failure on one shouldn't mask a success on another.
const DEFAULT_PROVIDERS = ["etherscan", "blockscout", "sourcify"] as const;
type Provider = NonNullable<VerifyContractArgs["provider"]>;

export type VerifyOpts = {
  /** Fully qualified name, e.g. `contracts/HashPowerPerpsDEX.sol:HashPowerPerpsDEX`. */
  contract?: string;
  force?: boolean;
};

/// Verify on each provider in turn. Never throws — failures are logged so a
/// caller can decide whether Basescan has to succeed.
///
/// Returns whether Etherscan (Basescan) verification succeeded or was already
/// done. Blockscout and Sourcify are best-effort and do not affect the result.
export async function verifyContract(
  address: string,
  constructorArgs?: readonly unknown[],
  providers: readonly Provider[] = DEFAULT_PROVIDERS,
  opts: VerifyOpts = {},
): Promise<boolean> {
  // hardhat-verify defaults to the built-in `production` profile (isolated=true).
  // Deploy/compile use `default` (isolated=false). Isolated compilation changes
  // bytecode, so always use `default` to match on-chain artifacts.
  hre.globalOptions.buildProfile = "default";

  const normalizedArgs = (constructorArgs ?? []).map((arg) =>
    typeof arg === "string" && isAddress(arg) ? getAddress(arg) : arg,
  );

  const args: Omit<VerifyContractArgs, "provider"> = {
    address: getAddress(address),
    constructorArgs: normalizedArgs as unknown[],
    contract: opts.contract,
    force: opts.force,
  };

  let etherscanOk = !providers.includes("etherscan");
  for (const provider of providers) {
    console.log(`\nVerifying ${args.address} on ${provider}...`);
    try {
      await verifyOnceIndexed({ ...args, provider });
      console.log(`  ${provider}: verified.`);
      if (provider === "etherscan") etherscanOk = true;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (msg.includes("Already Verified") || msg.includes("already been verified")) {
        console.log(`  ${provider}: already verified.`);
        if (provider === "etherscan") etherscanOk = true;
      } else {
        console.warn(`  ${provider}: verification failed — ${msg}`);
      }
    }
  }
  return etherscanOk;
}

const INDEX_RETRY_MS = 15_000;
const INDEX_TIMEOUT_MS = 300_000;

/// An explorer indexes a new contract a minute or so after it is mined and
/// until then reports that the address has no bytecode.
async function verifyOnceIndexed(args: VerifyContractArgs): Promise<void> {
  const deadline = Date.now() + INDEX_TIMEOUT_MS;
  for (;;) {
    try {
      await hreVerify(args, hre);
      return;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (!msg.includes("does not have bytecode") || Date.now() > deadline) throw err;
      console.log(`  ${args.provider}: not indexed yet; retrying in ${INDEX_RETRY_MS / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, INDEX_RETRY_MS));
    }
  }
}
