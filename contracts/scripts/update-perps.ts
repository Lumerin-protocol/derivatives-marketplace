import { requireEnvsSet } from "../lib/env.ts";
import { network } from "hardhat";
import {
  encodeFunctionData,
  getAddress,
  type Address,
  type Hex,
  type PublicClient,
  zeroAddress,
} from "viem";
import { writeAndWait } from "../lib/writeContract.ts";
import { verifyContract } from "../lib/verify.ts";
import { txUrl, addrUrl } from "../lib/explorer.ts";
import { logTitle, logInfo, logStep, logSuccess, logPrompt } from "../lib/log.ts";

// Target init version after running `initializeV2` on the proxy.
const TARGET_INIT_VERSION = 2n;
const ORDER_AGGREGATE_VERSION = [2, 13, 0] as const;

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

function isBeforeOrderAggregateVersion(version: unknown): boolean {
  if (typeof version !== "string") return true;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return true;
  const parsed = match.slice(1).map(Number);
  for (let i = 0; i < ORDER_AGGREGATE_VERSION.length; i++) {
    if (parsed[i] < ORDER_AGGREGATE_VERSION[i]) return true;
    if (parsed[i] > ORDER_AGGREGATE_VERSION[i]) return false;
  }
  return false;
}

function readOrderCacheUsers(required: boolean): Address[] {
  const values = (process.env.PERPS_ORDER_CACHE_USERS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => getAddress(value));
  const users = [...new Set(values)];
  if (required && users.length === 0) {
    throw new Error(
      "PERPS_ORDER_CACHE_USERS is required when upgrading from before 2.13.0; " +
        "set it to the complete comma-separated active-order user list (currently two addresses)",
    );
  }
  return users;
}

async function main() {
  logTitle("HashPowerPerpsDEX Upgrade");

  const env = requireEnvsSet("PERPS_ADDRESS", "VAULT_ADDRESS");

  const proxyAddress = env.PERPS_ADDRESS as Hex;

  const { viem } = await network.connect();
  const [deployer] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  logInfo("deployer", { Address: addrUrl(pc, deployer.account.address) });

  // Get current proxy contract
  const perps = await viem.getContractAt("HashPowerPerpsDEX", proxyAddress);
  async function scanOrderAggregate(user: Address) {
    let buyQty = 0n;
    let sellQty = 0n;
    let buyValue = 0n;
    let sellValue = 0n;
    const quantityDecimals = await perps.read.QUANTITY_DECIMALS();
    const scale = 10n ** BigInt(quantityDecimals);
    for (const id of await perps.read.getUserOrders([user])) {
      const order = await perps.read.getOrder([id]);
      if (order.quantity > 0n) {
        buyQty += order.quantity;
        buyValue += (order.price * order.quantity) / scale;
      } else if (order.quantity < 0n) {
        const absQty = -order.quantity;
        sellQty += absQty;
        sellValue += (order.price * absQty) / scale;
      }
    }
    return { buyQty, sellQty, buyValue, sellValue };
  }
  const currentOwner = await perps.read.owner();
  const currentCodeVersion = await perps.read.VERSION().catch(() => "unknown");
  const currentInitVersion = await readInitializedVersion(pc, proxyAddress);
  logInfo("proxy", {
    Address: addrUrl(pc, proxyAddress),
    Owner: currentOwner,
    Version: currentCodeVersion,
    InitVersion: currentInitVersion.toString(),
  });

  if (currentOwner.toLowerCase() !== deployer.account.address.toLowerCase()) {
    throw new Error(`Deployer ${deployer.account.address} is not the proxy owner ${currentOwner}`);
  }

  const vaultAddress = env.VAULT_ADDRESS as Hex;

  // Decide which migrations must run atomically with the upgrade.
  const needsV2Init = currentInitVersion < TARGET_INIT_VERSION;
  const needsOrderAggregateMigration = isBeforeOrderAggregateVersion(currentCodeVersion);
  const orderCacheUsers = readOrderCacheUsers(needsOrderAggregateMigration);
  const migrationCalls: Hex[] = [];
  if (needsV2Init) {
    const portfolioMarginAddress = (process.env.PME_ADDRESS ?? zeroAddress) as Hex;
    logInfo("initializeV2 required", {
      from: currentInitVersion.toString(),
      to: TARGET_INIT_VERSION.toString(),
      portfolioMargin:
        portfolioMarginAddress === zeroAddress
          ? "(unset — set later via setPortfolioMargin)"
          : addrUrl(pc, portfolioMarginAddress),
    });
    migrationCalls.push(encodeFunctionData({
      abi: perps.abi,
      functionName: "initializeV2",
      args: [vaultAddress, portfolioMarginAddress],
    }));
  } else {
    logInfo("initializeV2 skipped", {
      reason: `proxy already at init version ${currentInitVersion}`,
    });
  }

  if (needsOrderAggregateMigration) {
    logInfo("Order aggregate cache migration", {
      users: orderCacheUsers.join(", "),
    });
    migrationCalls.push(encodeFunctionData({
      abi: perps.abi,
      functionName: "rebuildOrderAggregateCache",
      args: [orderCacheUsers],
    }));
  } else {
    logInfo("Order aggregate cache migration skipped", {
      reason: `proxy version ${currentCodeVersion} is already 2.13.0 or newer`,
    });
  }

  const initData = migrationCalls.length > 1
    ? encodeFunctionData({
        abi: perps.abi,
        functionName: "multicall",
        args: [migrationCalls],
      })
    : migrationCalls[0] ?? "0x";

  await logPrompt("Review the configuration above. Proceed with upgrade?");

  console.log();

  // Deploy new HashPowerPerpsDEX implementation
  logInfo("Deploy new HashPowerPerpsDEX implementation", {
    contract: "HashPowerPerpsDEX",
    args: `vault=${vaultAddress}`,
  });
  await logPrompt("Proceed?");
  console.log("Deploying new implementation...");
  const newImpl = await viem.deployContract(
    "HashPowerPerpsDEX",
    [vaultAddress],
    { confirmations: 5 },
  );
  logStep("Deployed", addrUrl(pc, newImpl.address));

  console.log("Verifying new implementation...");
  await verifyContract(newImpl.address, [vaultAddress]);
  logStep("Verified", addrUrl(pc, newImpl.address));

  // Upgrade proxy to new implementation
  logInfo("Upgrade proxy", {
    Proxy: addrUrl(pc, proxyAddress),
    "New implementation": addrUrl(pc, newImpl.address),
    Call: migrationCalls.length > 0 ? `${migrationCalls.length} migration call(s)` : "none",
  });
  await logPrompt("Proceed with upgradeToAndCall?");
  console.log("Upgrading proxy...");
  const estimatedGas = await pc.estimateContractGas({
    address: proxyAddress,
    abi: newImpl.abi,
    functionName: "upgradeToAndCall",
    args: [newImpl.address, initData],
    account: deployer.account,
  });
  logStep("Estimated gas", estimatedGas.toString());
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

  const postCodeVersion = await perps.read.VERSION();
  if (postCodeVersion !== "2.13.0") {
    throw new Error(`Post-upgrade code version is ${postCodeVersion}, expected 2.13.0`);
  }
  logStep("Code version", postCodeVersion);

  if (needsOrderAggregateMigration) {
    for (const user of orderCacheUsers) {
      const expected = await scanOrderAggregate(user);
      const actual = await perps.read.getOrderAggregate([user]);
      if (
        actual.buyQty !== expected.buyQty ||
        actual.sellQty !== expected.sellQty ||
        actual.buyValue !== expected.buyValue ||
        actual.sellValue !== expected.sellValue
      ) {
        throw new Error(
          `Order aggregate verification failed for ${user}: ` +
            `cache=${Object.values(actual).join(",")} scan=${Object.values(expected).join(",")}`,
        );
      }
    }
    logStep("Order aggregates verified", `${orderCacheUsers.length} user(s)`);
  }

  // Optional: plug in the points/rewards hook. The venue must already hold
  // HOOK_CALLER_ROLE on the hook (granted by the points deploy) before this.
  const pointsHookAddress = (process.env.HOOK_ADDRESS ?? "") as Hex;
  if (pointsHookAddress && pointsHookAddress !== zeroAddress) {
    const currentHook = await perps.read.hook();
    if (currentHook.toLowerCase() === pointsHookAddress.toLowerCase()) {
      logStep("setHook", `skipped (already set to ${pointsHookAddress})`);
    } else {
      logInfo("setHook", { current: currentHook, new: pointsHookAddress });
      await logPrompt("Proceed?");
      const sim = await perps.simulate.setHook([pointsHookAddress]);
      const receipt = await writeAndWait(deployer, sim);
      logStep("setHook", txUrl(pc, receipt.transactionHash));
      logStep("Hook", await perps.read.hook());
    }
  }

  logSuccess(addrUrl(pc, proxyAddress));
}

main();
