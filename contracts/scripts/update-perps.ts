import { network } from "hardhat";
import {
  type Address,
  type Hex,
  type PublicClient,
  encodeFunctionData,
  getAddress,
  isAddress,
  zeroAddress,
} from "viem";
import { estimateContractGas, simulateContract } from "viem/actions";
import { OperationType } from "@safe-global/types-kit";
import { requireEnvsSet } from "../lib/env.ts";
import { addrUrl, txUrl } from "../lib/explorer.ts";
import { logInfo, logPrompt, logStep, logSuccess, logTitle } from "../lib/log.ts";
import { SafeWallet } from "../lib/safe.ts";
import { verifyContract } from "../lib/verify.ts";
import { writeAndWait } from "../lib/writeContract.ts";

// Initializers are versioned and must run in order: `initializeV2` (reinitializer 2)
// then `initializeV3` (reinitializer 3). Calling V3 first from version 1 permanently
// skips V2. Fresh proxies from `deploy-perps.ts` already sit on 3.
const TARGET_CODE_VERSION = "6.5.0";
const UPGRADE_CONFIRMATIONS = 5;
const DEFAULT_SAFE_GAS_OVERHEAD = 150_000n;

// ERC-7201 namespaced storage slot for OpenZeppelin's `Initializable`.
const INITIALIZABLE_STORAGE_SLOT: Hex =
  "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00";

function readNonNegativeBigInt(name: string): bigint {
  const raw = process.env[name];
  if (!raw) throw new Error(`Environment variable ${name} is required`);
  const value = BigInt(raw);
  if (value < 0n) throw new Error(`${name} must not be negative`);
  return value;
}

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

async function main() {
  logTitle("HashPowerPerpsDEX Atomic Upgrade and Reset");

  const env = requireEnvsSet(
    "PERPS_ADDRESS",
    "VAULT_ADDRESS",
    "PERPS_DEPLOYMENT_BLOCK",
  );
  const proxyAddress = getAddress(env.PERPS_ADDRESS);
  const vaultAddress = getAddress(env.VAULT_ADDRESS);
  const pmeAddress =
    readOptionalAddress("PME_ADDRESS") ??
    readOptionalAddress("MARGIN_ENGINE_ADDRESS") ??
    zeroAddress;
  const configuredSafe = readOptionalAddress("SAFE_OWNER_ADDRESS");
  const pointsHookAddress = readOptionalAddress("HOOK_ADDRESS");
  const existingImpl = readOptionalAddress("PERPS_IMPL_ADDRESS");
  const deploymentBlock = readNonNegativeBigInt("PERPS_DEPLOYMENT_BLOCK");

  const { viem } = await network.getOrCreate();
  const [deployer] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  const snapshotBlock = await pc.getBlockNumber();
  const perps = await viem.getContractAt("HashPowerPerpsDEX", proxyAddress);
  const currentOwner = getAddress(
    await perps.read.owner({ blockNumber: snapshotBlock }),
  );
  const deployerAddress = getAddress(deployer.account.address);
  const currentCodeVersion = await perps.read.VERSION({ blockNumber: snapshotBlock }).catch(() => "unknown");
  const currentInitVersion = await readInitializedVersion(
    pc,
    proxyAddress,
    snapshotBlock,
  );
  const needsInitializeV2 = currentInitVersion < 2n;
  const needsInitializeV3 = currentInitVersion < 3n;

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
    initializeV2: needsInitializeV2 ? "yes" : "skip (already >= 2)",
    initializeV3: needsInitializeV3 ? "yes" : "skip (already >= 3)",
    Vault: addrUrl(pc, vaultAddress),
    PME:
      pmeAddress === zeroAddress
        ? "(none — wire later)"
        : addrUrl(pc, pmeAddress),
    "Deployment block": deploymentBlock,
    "Snapshot block": snapshotBlock,
  });

  if (upgradeCaller !== currentOwner) {
    throw new Error(
      `Configured upgrade caller ${upgradeCaller} is not HashPowerPerpsDEX owner ${currentOwner}`,
    );
  }

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

  // reinitializer(n) permanently skips any lower n. If we still need V2, it
  // must run before V3 — otherwise initializeV2 is locked out forever.
  const upgradeCalldata = needsInitializeV2
    ? encodeFunctionData({
        abi: newImpl.abi,
        functionName: "initializeV2",
        args: [vaultAddress, pmeAddress],
      })
    : needsInitializeV3
      ? encodeFunctionData({
          abi: newImpl.abi,
          functionName: "initializeV3",
        })
      : "0x";
  const upgradeCall = needsInitializeV2
    ? "initializeV2"
    : needsInitializeV3
      ? "initializeV3"
      : "(none)";
  const needsFollowUpInitializeV3 = needsInitializeV2 && needsInitializeV3;

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
        `= ${requiredBlockGas}, limit ${maxAtomicUpgradeGas}.`,
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

    if (needsFollowUpInitializeV3) {
      logInfo("Propose initializeV3 via Safe", {
        note: "Execute after the upgrade transaction",
      });
      await logPrompt("Proceed?");
      const initV3Data = encodeFunctionData({
        abi: newImpl.abi,
        functionName: "initializeV3",
      });
      const initV3TxHash = await safe.proposeTransaction({
        data: initV3Data,
        to: proxyAddress,
        value: "0",
        operation: OperationType.Call,
      });
      logStep("Safe TX hash", initV3TxHash);
      logStep("Safe UI URL", safe.getSafeUITxUrl(initV3TxHash));
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

    let postInitVersion = await readInitializedVersion(
      pc,
      proxyAddress,
      receipt.blockNumber,
    );
    if (needsInitializeV2 && postInitVersion < 2n) {
      throw new Error(
        `initializeV2 did not advance init version (still ${postInitVersion})`,
      );
    }

    if (needsFollowUpInitializeV3 && postInitVersion < 3n) {
      logInfo("initializeV3", { from: postInitVersion.toString() });
      await logPrompt("Submit initializeV3?");
      const initV3Simulation = await perps.simulate.initializeV3();
      const initV3Receipt = await writeAndWait(
        deployer,
        initV3Simulation,
        UPGRADE_CONFIRMATIONS,
      );
      logStep("initializeV3", txUrl(pc, initV3Receipt.transactionHash));
      postInitVersion = await readInitializedVersion(
        pc,
        proxyAddress,
        initV3Receipt.blockNumber,
      );
    }

    const expectedInitVersion = needsInitializeV3 ? 3n : currentInitVersion;
    if (postInitVersion !== expectedInitVersion) {
      throw new Error(
        `Init version ${postInitVersion}, expected ${expectedInitVersion}`,
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
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
