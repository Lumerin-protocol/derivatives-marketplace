import { requireEnvsSet } from "../lib/env.ts";
import { network } from "hardhat";
import { encodeFunctionData, type Hex, type PublicClient, zeroAddress } from "viem";
import { writeAndWait } from "../lib/writeContract.ts";
import { verifyContract } from "../lib/verify.ts";
import { txUrl, addrUrl } from "../lib/explorer.ts";
import { logTitle, logInfo, logStep, logSuccess, logPrompt } from "../lib/log.ts";

// Target init version after running `initializeV2` on the proxy.
const TARGET_INIT_VERSION = 2n;

// ERC-7201 namespaced storage slot for OpenZeppelin's `Initializable`:
//   keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.Initializable")) - 1)) & ~bytes32(uint256(0xff))
// Layout at this slot: { uint64 _initialized; bool _initializing; } (packed, low bytes first).
const INITIALIZABLE_STORAGE_SLOT: Hex =
  "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00";

async function readInitializedVersion(pc: PublicClient, proxy: Hex): Promise<bigint> {
  const raw = await pc.getStorageAt({ address: proxy, slot: INITIALIZABLE_STORAGE_SLOT });
  if (!raw || raw === "0x" || raw === "0x0") return 0n;
  // `_initialized` is a uint64 occupying the lowest 8 bytes of the 32-byte slot
  // (EVM packs structs right-aligned per field in the same slot, starting from the low-order end).
  const word = BigInt(raw);
  return word & 0xffffffffffffffffn;
}

async function main() {
  logTitle("HashPowerPerpsDEX Upgrade");

  const env = requireEnvsSet("PERPS_ADDRESS", "MINIMUM_PRICE_INCREMENT");

  const proxyAddress = env.PERPS_ADDRESS as Hex;

  const { viem } = await network.connect();
  const [deployer] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  logInfo("deployer", { Address: addrUrl(pc, deployer.account.address) });

  // Get current proxy contract
  const perps = await viem.getContractAt("HashPowerPerpsDEX", proxyAddress);
  const currentOwner = await perps.read.owner();
  const currentInitVersion = await readInitializedVersion(pc, proxyAddress);
  logInfo("proxy", {
    Address: addrUrl(pc, proxyAddress),
    Owner: currentOwner,
    InitVersion: currentInitVersion.toString(),
  });

  if (currentOwner.toLowerCase() !== deployer.account.address.toLowerCase()) {
    throw new Error(`Deployer ${deployer.account.address} is not the proxy owner ${currentOwner}`);
  }

  // Decide whether the upgrade needs to run `initializeV2` atomically.
  const needsV2Init = currentInitVersion < TARGET_INIT_VERSION;
  let initData: Hex = "0x";
  if (needsV2Init) {
    const v2Env = requireEnvsSet("VAULT_ADDRESS");
    const vaultAddress = v2Env.VAULT_ADDRESS as Hex;
    const portfolioMarginAddress = (process.env.PME_ADDRESS ?? zeroAddress) as Hex;
    logInfo("initializeV2 required", {
      from: currentInitVersion.toString(),
      to: TARGET_INIT_VERSION.toString(),
      vault: addrUrl(pc, vaultAddress),
      portfolioMargin:
        portfolioMarginAddress === zeroAddress
          ? "(unset — set later via setPortfolioMargin)"
          : addrUrl(pc, portfolioMarginAddress),
    });
    initData = encodeFunctionData({
      abi: perps.abi,
      functionName: "initializeV2",
      args: [vaultAddress, portfolioMarginAddress],
    });
  } else {
    logInfo("initializeV2 skipped", {
      reason: `proxy already at init version ${currentInitVersion}`,
    });
  }

  await logPrompt("Review the configuration above. Proceed with upgrade?");

  console.log();

  // Deploy new HashPowerPerpsDEX implementation
  logInfo("Deploy new HashPowerPerpsDEX implementation", {
    contract: "HashPowerPerpsDEX",
    args: `minimumPriceIncrement=${env.MINIMUM_PRICE_INCREMENT}`,
  });
  await logPrompt("Proceed?");
  console.log("Deploying new implementation...");
  const newImpl = await viem.deployContract("HashPowerPerpsDEX", [
    BigInt(env.MINIMUM_PRICE_INCREMENT),
  ]);
  logStep("Deployed", addrUrl(pc, newImpl.address));

  console.log("Verifying new implementation...");
  await verifyContract(newImpl.address, [env.MINIMUM_PRICE_INCREMENT]);
  logStep("Verified", addrUrl(pc, newImpl.address));

  // Upgrade proxy to new implementation
  logInfo("Upgrade proxy", {
    Proxy: addrUrl(pc, proxyAddress),
    "New implementation": addrUrl(pc, newImpl.address),
    Call: needsV2Init ? "initializeV2(vault, portfolioMargin)" : "none",
  });
  await logPrompt("Proceed with upgradeToAndCall?");
  console.log("Upgrading proxy...");
  const upgradeRes = await perps.simulate.upgradeToAndCall([newImpl.address, initData]);
  const upgradeReceipt = await writeAndWait(deployer, upgradeRes);
  logStep("Upgraded", txUrl(pc, upgradeReceipt.transactionHash));

  if (needsV2Init) {
    const postVersion = await readInitializedVersion(pc, proxyAddress);
    if (postVersion !== TARGET_INIT_VERSION) {
      throw new Error(
        `Post-upgrade init version is ${postVersion}, expected ${TARGET_INIT_VERSION}`,
      );
    }
    logStep("Init version", postVersion.toString());
  }

  logSuccess(addrUrl(pc, proxyAddress));
}

main();
