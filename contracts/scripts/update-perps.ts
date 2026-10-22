import { network } from "hardhat";
import {
  type Address,
  type Hex,
  type PublicClient,
  encodeFunctionData,
  getAddress,
  isAddress,
  parseAbi,
  zeroAddress,
} from "viem";
import { estimateContractGas, simulateContract } from "viem/actions";
import { OperationType } from "@safe-global/types-kit";
import { requireEnvsSet } from "../lib/env.ts";
import { addrUrl, txUrl } from "../lib/explorer.ts";
import {
  logInfo,
  logPrompt,
  logStep,
  logSuccess,
  logTitle,
} from "../lib/log.ts";
import { SafeWallet } from "../lib/safe.ts";
import { verifyContract } from "../lib/verify.ts";
import { writeAndWait } from "../lib/writeContract.ts";
import {
  DEFAULT_BLOCK_CHUNK,
  collectParticipants,
  fetchDeploymentBlockFromEtherscan,
} from "./lib/participants.ts";
import { ensureVaultHalted } from "./lib/halt.ts";
import {
  assertNoRestingOrders,
  chunk,
  usersWithRestingOrders,
} from "./lib/resting-orders.ts";

// Upgrades run no initializer, so the proxy's init version must not move.
//
// 6.10 starts a new resting-order aggregate, so orders placed before it must not survive the
// upgrade: with the shared vault halted, the upgrade call is `forceCancelOrders` for every user
// with resting orders (further batches follow while still halted). Resume the vault only once
// every venue is upgraded and verified (`VERIFY_ONLY=true` checks a venue without upgrading).
const DEFAULT_FORCE_CANCEL_BATCH_SIZE = 20;
const TARGET_CODE_VERSION = "6.12.0";
const UPGRADE_CONFIRMATIONS = 5;
const DEFAULT_SAFE_GAS_OVERHEAD = 150_000n;
// 6.8.0 calls the engine's `reduceLimits` / `meetsTradeMargin` on every order. Against an
// older engine every order reverts, so the engine has to be upgraded first.
const MIN_ENGINE_VERSION = "2.2.0";
const VERSION_ABI = parseAbi(["function VERSION() view returns (string)"]);

// ERC-7201 namespaced storage slot for OpenZeppelin's `Initializable`.
const INITIALIZABLE_STORAGE_SLOT: Hex =
  "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00";

function readOptionalBigInt(name: string): bigint | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  return BigInt(raw);
}

function readOptionalAddress(name: string): Address | undefined {
  const raw = process.env[name];
  if (!raw || raw === zeroAddress) return undefined;
  if (!isAddress(raw))
    throw new Error(`${name} is not a valid address: ${raw}`);
  return getAddress(raw);
}

async function readInitializedVersion(
  pc: PublicClient,
  proxy: Address,
  blockNumber?: bigint,
): Promise<bigint> {
  const raw = await pc.getStorageAt({
    address: proxy,
    slot: INITIALIZABLE_STORAGE_SLOT,
    blockNumber,
  });
  if (!raw || raw === "0x" || raw === "0x0") return 0n;
  return BigInt(raw) & 0xffffffffffffffffn;
}

/** Dotted-version comparison; an unreadable version never passes. */
function versionAtLeast(version: string, min: string): boolean {
  const have = version.split(".").map(Number);
  const want = min.split(".").map(Number);
  for (let i = 0; i < want.length; i++) {
    const part = have[i] ?? 0;
    if (part !== want[i]) return part > want[i];
  }
  return true;
}

async function requireEngineVersion(
  pc: PublicClient,
  engine: Address,
  blockNumber?: bigint,
): Promise<void> {
  const version = await pc
    .readContract({
      address: engine,
      abi: VERSION_ABI,
      functionName: "VERSION",
      blockNumber,
    })
    .catch(() => "unknown");
  if (!versionAtLeast(version, MIN_ENGINE_VERSION)) {
    throw new Error(
      `PortfolioMarginEngine ${engine} is at ${version}; upgrade it to ${MIN_ENGINE_VERSION} or later before this venue`,
    );
  }
}

async function main() {
  logTitle("HashPowerPerpsDEX Upgrade");

  const env = requireEnvsSet("PERPS_ADDRESS", "VAULT_ADDRESS");
  const proxyAddress = getAddress(env.PERPS_ADDRESS);
  const vaultAddress = getAddress(env.VAULT_ADDRESS);
  const configuredSafe = readOptionalAddress("SAFE_OWNER_ADDRESS");
  const pointsHookAddress = readOptionalAddress("HOOK_ADDRESS");
  const existingImpl = readOptionalAddress("PERPS_IMPL_ADDRESS");

  const { viem } = await network.getOrCreate();
  const [deployer] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  const snapshotBlock = await pc.getBlockNumber();
  const perps = await viem.getContractAt("HashPowerPerpsDEX", proxyAddress);
  const currentOwner = getAddress(
    await perps.read.owner({ blockNumber: snapshotBlock }),
  );
  const deployerAddress = getAddress(deployer.account.address);
  const currentCodeVersion = await perps.read
    .VERSION({ blockNumber: snapshotBlock })
    .catch(() => "unknown");
  const currentInitVersion = await readInitializedVersion(
    pc,
    proxyAddress,
    snapshotBlock,
  );

  const wiredEngine = getAddress(
    await perps.read
      .portfolioMargin({ blockNumber: snapshotBlock })
      .catch(() => zeroAddress),
  );
  if (wiredEngine !== zeroAddress) {
    await requireEngineVersion(pc, wiredEngine, snapshotBlock);
  }

  if (configuredSafe && configuredSafe !== currentOwner) {
    throw new Error(
      `SAFE_OWNER_ADDRESS ${configuredSafe} is not proxy owner ${currentOwner}`,
    );
  }
  const safeOwnerAddress =
    configuredSafe ??
    (currentOwner !== deployerAddress ? currentOwner : undefined);
  const upgradeCaller = safeOwnerAddress ?? deployerAddress;

  logInfo("deployer", { Address: addrUrl(pc, deployerAddress) });
  if (safeOwnerAddress) {
    logInfo("safe owner", { Address: safeOwnerAddress });
  }

  logInfo("preflight", {
    Proxy: addrUrl(pc, proxyAddress),
    Owner: currentOwner,
    Version: currentCodeVersion,
    InitVersion: currentInitVersion.toString(),
    Vault: addrUrl(pc, vaultAddress),
    PME: wiredEngine === zeroAddress ? "(none wired)" : addrUrl(pc, wiredEngine),
    "Snapshot block": snapshotBlock,
  });

  if (upgradeCaller !== currentOwner) {
    throw new Error(
      `Configured upgrade caller ${upgradeCaller} is not HashPowerPerpsDEX owner ${currentOwner}`,
    );
  }

  const startBlock =
    readOptionalBigInt("START_BLOCK") ??
    (await fetchDeploymentBlockFromEtherscan(pc, proxyAddress));
  const blockChunk = readOptionalBigInt("BLOCK_CHUNK_SIZE") ?? DEFAULT_BLOCK_CHUNK;
  if (process.env.VERIFY_ONLY === "true") {
    const candidates = await collectParticipants(pc, proxyAddress, {
      startBlock,
      endBlock: snapshotBlock,
      blockChunk,
    });
    await assertNoRestingOrders(pc, proxyAddress, candidates, snapshotBlock);
    logSuccess(
      `No resting orders at block ${snapshotBlock} (${candidates.length} participants checked)`,
    );
    return;
  }

  // Listed only once halted, so no user can place an order the cancellation would miss.
  const ordersBlock = await ensureVaultHalted(pc, vaultAddress, deployer);
  const candidates = await collectParticipants(pc, proxyAddress, {
    startBlock,
    endBlock: ordersBlock,
    blockChunk,
  });
  const usersWithOrders = await usersWithRestingOrders(
    pc,
    proxyAddress,
    candidates,
    ordersBlock,
  );
  const cancelBatches = chunk(
    usersWithOrders,
    Number(
      readOptionalBigInt("FORCE_CANCEL_BATCH_SIZE") ??
        BigInt(DEFAULT_FORCE_CANCEL_BATCH_SIZE),
    ),
  );
  logInfo("resting orders", {
    "Orders block": ordersBlock,
    "Users with resting orders": usersWithOrders.length,
    "forceCancelOrders batches": cancelBatches.length,
  });

  await logPrompt("Preflight complete. Deploy implementation?");
  const newImpl = existingImpl
    ? await viem.getContractAt("HashPowerPerpsDEX", existingImpl)
    : await viem.deployContract("HashPowerPerpsDEX", [vaultAddress], {
        confirmations: UPGRADE_CONFIRMATIONS,
      });

  logStep(
    existingImpl ? "Using existing implementation" : "Deployed",
    addrUrl(pc, newImpl.address),
  );
  if (!existingImpl) {
    await verifyContract(newImpl.address, [vaultAddress]);
    logStep("Verified", addrUrl(pc, newImpl.address));
  }

  const implVersion = await newImpl.read.VERSION();
  if (implVersion !== TARGET_CODE_VERSION) {
    throw new Error(
      `Implementation VERSION is ${implVersion}, expected ${TARGET_CODE_VERSION}`,
    );
  }

  const [firstBatch, ...followUpBatches] = cancelBatches;
  const upgradeCalldata = firstBatch
    ? encodeFunctionData({
        abi: newImpl.abi,
        functionName: "forceCancelOrders",
        args: [firstBatch],
      })
    : "0x";
  const upgradeCall = firstBatch
    ? `forceCancelOrders(${firstBatch.length} users)`
    : "(none)";

  const upgradeArgs = [newImpl.address, upgradeCalldata] as const;
  await simulateContract(pc, {
    address: proxyAddress,
    abi: newImpl.abi,
    functionName: "upgradeToAndCall",
    args: upgradeArgs,
    account: upgradeCaller,
  });
  const estimatedUpgradeGas = await estimateContractGas(pc, {
    address: proxyAddress,
    abi: newImpl.abi,
    functionName: "upgradeToAndCall",
    args: upgradeArgs,
    account: upgradeCaller,
  });
  const latestBlock = await pc.getBlock();
  const configuredMaxAtomicGas = readOptionalBigInt("MAX_ATOMIC_UPGRADE_GAS");
  if (configuredMaxAtomicGas !== undefined && configuredMaxAtomicGas < 0n) {
    throw new Error("MAX_ATOMIC_UPGRADE_GAS must not be negative");
  }
  const maxAtomicUpgradeGas =
    configuredMaxAtomicGas !== undefined &&
    configuredMaxAtomicGas < latestBlock.gasLimit
      ? configuredMaxAtomicGas
      : latestBlock.gasLimit;
  const safeGasOverhead = safeOwnerAddress
    ? (readOptionalBigInt("SAFE_EXECUTION_GAS_OVERHEAD") ??
      DEFAULT_SAFE_GAS_OVERHEAD)
    : 0n;
  const requiredBlockGas = estimatedUpgradeGas + safeGasOverhead;
  if (requiredBlockGas > maxAtomicUpgradeGas) {
    throw new Error(
      `Upgrade cannot fit: estimate ${estimatedUpgradeGas} + Safe overhead ${safeGasOverhead} ` +
        `= ${requiredBlockGas}, limit ${maxAtomicUpgradeGas}. Lower FORCE_CANCEL_BATCH_SIZE.`,
    );
  }
  logInfo("upgrade preflight", {
    "New implementation": addrUrl(pc, newImpl.address),
    Call: upgradeCall,
    Simulation: "passed",
    "Estimated upgrade gas": estimatedUpgradeGas,
    "Safe execution overhead": safeGasOverhead,
    "Enforced gas limit": maxAtomicUpgradeGas,
  });

  if (safeOwnerAddress) {
    const { SAFE_API_KEY } = requireEnvsSet("SAFE_API_KEY");
    const safe = new SafeWallet(safeOwnerAddress, deployer, SAFE_API_KEY);

    logInfo("Propose upgrade via Safe", { safe: safeOwnerAddress });
    await logPrompt("Proceed?");
    const upgradeTxData = encodeFunctionData({
      abi: newImpl.abi,
      functionName: "upgradeToAndCall",
      args: upgradeArgs,
    });
    const upgradeTxHash = await safe.proposeTransaction({
      data: upgradeTxData,
      to: proxyAddress,
      value: "0",
      operation: OperationType.Call,
    });
    logStep("Safe TX hash", upgradeTxHash);
    logStep("Safe UI URL", safe.getSafeUITxUrl(upgradeTxHash));

    for (const [i, batch] of followUpBatches.entries()) {
      const cancelTxHash = await safe.proposeTransaction({
        data: encodeFunctionData({
          abi: newImpl.abi,
          functionName: "forceCancelOrders",
          args: [batch],
        }),
        to: proxyAddress,
        value: "0",
        operation: OperationType.Call,
      });
      logStep(
        `forceCancelOrders batch ${i + 2}/${cancelBatches.length}`,
        safe.getSafeUITxUrl(cancelTxHash),
      );
    }

    if (pointsHookAddress) {
      logInfo("Propose setHook via Safe", { hook: pointsHookAddress });
      await logPrompt("Proceed?");
      const setHookData = encodeFunctionData({
        abi: newImpl.abi,
        functionName: "setHook",
        args: [pointsHookAddress],
      });
      const setHookTxHash = await safe.proposeTransaction({
        data: setHookData,
        to: proxyAddress,
        value: "0",
        operation: OperationType.Call,
      });
      logStep("Safe TX hash", setHookTxHash);
      logStep("Safe UI URL", safe.getSafeUITxUrl(setHookTxHash));
    }
  } else {
    await logPrompt("Submit upgradeToAndCall?");
    const upgradeSimulation =
      await perps.simulate.upgradeToAndCall(upgradeArgs);
    const receipt = await writeAndWait(
      deployer,
      upgradeSimulation,
      UPGRADE_CONFIRMATIONS,
    );
    logStep(
      "Upgraded",
      `${txUrl(pc, receipt.transactionHash)} block ${receipt.blockNumber}`,
    );

    const postInitVersion = await readInitializedVersion(
      pc,
      proxyAddress,
      receipt.blockNumber,
    );
    if (postInitVersion !== currentInitVersion) {
      throw new Error(
        `Init version moved from ${currentInitVersion} to ${postInitVersion}`,
      );
    }
    const postCodeVersion = await perps.read.VERSION({
      blockNumber: receipt.blockNumber,
    });
    if (postCodeVersion !== TARGET_CODE_VERSION) {
      throw new Error(
        `Post-upgrade code version ${postCodeVersion}, expected ${TARGET_CODE_VERSION}`,
      );
    }

    logStep("Init version", postInitVersion.toString());
    logStep("Code version", postCodeVersion);

    let verifyBlock = receipt.blockNumber;
    for (const [i, batch] of followUpBatches.entries()) {
      const cancelReceipt = await writeAndWait(
        deployer,
        await perps.simulate.forceCancelOrders([batch]),
      );
      verifyBlock = cancelReceipt.blockNumber;
      logStep(
        `forceCancelOrders batch ${i + 2}/${cancelBatches.length}`,
        txUrl(pc, cancelReceipt.transactionHash),
      );
    }
    await assertNoRestingOrders(pc, proxyAddress, usersWithOrders, verifyBlock);
    logStep("Resting orders", `none left (${usersWithOrders.length} users cancelled)`);

    if (pointsHookAddress) {
      const currentHook = await perps.read.hook();
      if (currentHook.toLowerCase() !== pointsHookAddress.toLowerCase()) {
        logInfo("setHook", { current: currentHook, new: pointsHookAddress });
        await logPrompt("Proceed?");
        const simulation = await perps.simulate.setHook([pointsHookAddress]);
        const hookReceipt = await writeAndWait(deployer, simulation);
        logStep("setHook", txUrl(pc, hookReceipt.transactionHash));
      }
    }
  }

  logSuccess(addrUrl(pc, proxyAddress));
  logInfo("next", {
    Resume: "resume the vault once every venue is upgraded and has no resting orders left",
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
