import { requireEnvsSet } from "../lib/env.ts";
import { network } from "hardhat";
import {
  encodeAbiParameters,
  encodeFunctionData,
  getAbiItem,
  getAddress,
  type Address,
  type Hex,
  keccak256,
  numberToHex,
  type PublicClient,
  zeroAddress,
} from "viem";
import { HashPowerPerpsDEXAbi } from "../abi/HashPowerPerpsDEX.ts";
import { writeAndWait } from "../lib/writeContract.ts";
import { verifyContract } from "../lib/verify.ts";
import { txUrl, addrUrl } from "../lib/explorer.ts";
import { logTitle, logInfo, logStep, logSuccess, logPrompt } from "../lib/log.ts";

const REQUIRED_CURRENT_INIT_VERSION = 3n;
const TARGET_CODE_VERSION = "2.15.0";
const UPGRADE_CONFIRMATIONS = 5;
const DEFAULT_EVENT_CHUNK_SIZE = 50_000n;
const DEFAULT_MAX_PARTICIPANTS = 10;
const POSITION_MAPPING_SLOT = 14n;
const FUNDING_SNAPSHOT_MAPPING_SLOT = 22n;

const ORDER_CREATED_EVENT = getAbiItem({
  abi: HashPowerPerpsDEXAbi,
  name: "OrderCreated",
});

const LEGACY_POSITION_ABI = [
  {
    type: "function",
    name: "getUserPosition",
    stateMutability: "view",
    inputs: [{ name: "_user", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "netQuantity", type: "int256" },
          { name: "aggregatedEntryPrice", type: "uint256" },
        ],
      },
    ],
  },
] as const;

// ERC-7201 namespaced storage slot for OpenZeppelin's `Initializable`.
const INITIALIZABLE_STORAGE_SLOT: Hex =
  "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00";

type LegacyPosition = {
  participant: Address;
  netQuantity: bigint;
  legacyAverage: bigint;
  orderCount: number;
  pendingFunding: bigint;
};

function readNonNegativeBigInt(name: string): bigint {
  const raw = process.env[name];
  if (!raw) throw new Error(`Environment variable ${name} is required`);
  const value = BigInt(raw);
  if (value < 0n) throw new Error(`${name} must not be negative`);
  return value;
}

function readPositiveBigInt(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = BigInt(raw);
  if (value <= 0n) throw new Error(`${name} must be positive`);
  return value;
}

function readPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
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

function mappingElementSlot(participant: Address, mappingSlot: bigint): Hex {
  const base = BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }],
        [participant, mappingSlot],
      ),
    ),
  );
  return numberToHex(base, { size: 32 });
}

function positionSecondSlot(participant: Address): Hex {
  return numberToHex(
    BigInt(mappingElementSlot(participant, POSITION_MAPPING_SLOT)) + 1n,
    { size: 32 },
  );
}

async function verifyDeploymentBoundary(
  pc: PublicClient,
  proxy: Address,
  deploymentBlock: bigint,
) {
  const codeAtDeployment = await pc.getCode({
    address: proxy,
    blockNumber: deploymentBlock,
  });
  if (!codeAtDeployment || codeAtDeployment === "0x") {
    throw new Error(`No proxy code at PERPS_DEPLOYMENT_BLOCK=${deploymentBlock}`);
  }
  if (deploymentBlock === 0n) return;
  const codeBefore = await pc.getCode({
    address: proxy,
    blockNumber: deploymentBlock - 1n,
  });
  if (codeBefore && codeBefore !== "0x") {
    throw new Error(
      `PERPS_DEPLOYMENT_BLOCK=${deploymentBlock} is too late; proxy code already existed one block earlier`,
    );
  }
}

async function discoverParticipants(
  pc: PublicClient,
  proxy: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Address[]> {
  const participants = new Map<string, Address>();
  const chunkSize = readPositiveBigInt(
    "UPGRADE_EVENT_CHUNK_SIZE",
    DEFAULT_EVENT_CHUNK_SIZE,
  );
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = start + chunkSize - 1n < toBlock ? start + chunkSize - 1n : toBlock;
    const logs = await pc.getLogs({
      address: proxy,
      event: ORDER_CREATED_EVENT,
      fromBlock: start,
      toBlock: end,
    });
    for (const log of logs) {
      const participant = log.args.participant;
      if (!participant) throw new Error(`OrderCreated missing participant in block ${log.blockNumber}`);
      const address = getAddress(participant);
      participants.set(address.toLowerCase(), address);
    }
    logStep(`index OrderCreated ${start}-${end}`, `${participants.size} participant(s)`);
  }
  return [...participants.values()].sort();
}

async function snapshotLegacyPositions(
  pc: PublicClient,
  proxy: Address,
  participants: Address[],
  blockNumber: bigint,
): Promise<LegacyPosition[]> {
  const positions: LegacyPosition[] = [];
  for (const participant of participants) {
    const position = await pc.readContract({
      address: proxy,
      abi: LEGACY_POSITION_ABI,
      functionName: "getUserPosition",
      args: [participant],
      blockNumber,
    });
    const secondSlot = await pc.getStorageAt({
      address: proxy,
      slot: positionSecondSlot(participant),
      blockNumber,
    });
    const rawSecondSlot = secondSlot ? BigInt(secondSlot) : 0n;
    if (rawSecondSlot !== position.aggregatedEntryPrice) {
      throw new Error(`Legacy position read/storage mismatch for ${participant}`);
    }
    const orderIds = await pc.readContract({
      address: proxy,
      abi: HashPowerPerpsDEXAbi,
      functionName: "getUserOrders",
      args: [participant],
      blockNumber,
    });
    const pendingFunding = await pc.readContract({
      address: proxy,
      abi: HashPowerPerpsDEXAbi,
      functionName: "getPendingFunding",
      args: [participant],
      blockNumber,
    });
    positions.push({
      participant,
      netQuantity: position.netQuantity,
      legacyAverage: position.aggregatedEntryPrice,
      orderCount: orderIds.length,
      pendingFunding,
    });
  }
  return positions;
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
  const deploymentBlock = readNonNegativeBigInt("PERPS_DEPLOYMENT_BLOCK");

  const { viem } = await network.connect();
  const [deployer] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  const snapshotBlock = await pc.getBlockNumber();
  const perps = await viem.getContractAt("HashPowerPerpsDEX", proxyAddress);
  const currentOwner = await perps.read.owner({ blockNumber: snapshotBlock });
  const currentCodeVersion = await perps.read.VERSION({ blockNumber: snapshotBlock }).catch(() => "unknown");
  const currentInitVersion = await readInitializedVersion(
    pc,
    proxyAddress,
    snapshotBlock,
  );

  if (getAddress(currentOwner) !== getAddress(deployer.account.address)) {
    throw new Error(`Deployer ${deployer.account.address} is not proxy owner ${currentOwner}`);
  }
  if (currentInitVersion !== REQUIRED_CURRENT_INIT_VERSION) {
    throw new Error(
      `Atomic reset upgrade requires init version ${REQUIRED_CURRENT_INIT_VERSION}; found ${currentInitVersion}`,
    );
  }

  await verifyDeploymentBoundary(pc, proxyAddress, deploymentBlock);
  const participants = await discoverParticipants(
    pc,
    proxyAddress,
    deploymentBlock,
    snapshotBlock,
  );
  const maxParticipants = readPositiveInteger(
    "UPGRADE_MAX_PARTICIPANTS",
    DEFAULT_MAX_PARTICIPANTS,
  );
  if (participants.length > maxParticipants) {
    throw new Error(
      `Discovered ${participants.length} participants, above safety limit ${maxParticipants}`,
    );
  }
  const legacyPositions = await snapshotLegacyPositions(
    pc,
    proxyAddress,
    participants,
    snapshotBlock,
  );

  logInfo("preflight", {
    Proxy: addrUrl(pc, proxyAddress),
    Owner: currentOwner,
    Version: currentCodeVersion,
    InitVersion: currentInitVersion.toString(),
    "Deployment block": deploymentBlock,
    "Snapshot block": snapshotBlock,
    "Complete participant index": participants.length,
    "Active positions": legacyPositions.filter((position) => position.netQuantity !== 0n).length,
    "Open orders": legacyPositions.reduce((total, position) => total + position.orderCount, 0),
  });
  for (const position of legacyPositions) {
    console.log(
      `  ${position.participant} qty=${position.netQuantity} legacyAvg=${position.legacyAverage} orders=${position.orderCount} pendingFunding=${position.pendingFunding}`,
    );
  }

  await logPrompt("Participant index and legacy position preflight are complete. Deploy implementation?");
  const newImpl = await viem.deployContract(
    "HashPowerPerpsDEX",
    [vaultAddress],
    { confirmations: UPGRADE_CONFIRMATIONS },
  );
  logStep("Deployed", addrUrl(pc, newImpl.address));
  await verifyContract(newImpl.address, [vaultAddress]);
  logStep("Verified", addrUrl(pc, newImpl.address));

  const initData = encodeFunctionData({
    abi: newImpl.abi,
    functionName: "resetParticipantState",
    args: [participants],
  });
  const upgradeArgs = [newImpl.address, initData] as const;
  const estimatedGas = await pc.estimateContractGas({
    address: proxyAddress,
    abi: newImpl.abi,
    functionName: "upgradeToAndCall",
    args: upgradeArgs,
    account: deployer.account,
  });
  const latestBlock = await pc.getBlock();
  if (estimatedGas >= latestBlock.gasLimit) {
    throw new Error(
      `Estimated upgrade gas ${estimatedGas} exceeds block gas limit ${latestBlock.gasLimit}`,
    );
  }
  const upgradeSimulation = await perps.simulate.upgradeToAndCall(upgradeArgs);
  logInfo("atomic upgrade", {
    "New implementation": addrUrl(pc, newImpl.address),
    Call: `resetParticipantState(${participants.length} participants)`,
    "Estimated gas": estimatedGas,
    "Block gas limit": latestBlock.gasLimit,
  });
  await logPrompt("Submit the single upgradeToAndCall reset transaction?");

  const receipt = await writeAndWait(
    deployer,
    upgradeSimulation,
    UPGRADE_CONFIRMATIONS,
  );
  const atUpgradeBlock = { blockNumber: receipt.blockNumber } as const;
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
    throw new Error(`Reset unexpectedly changed init version to ${postInitVersion}`);
  }
  const postCodeVersion = await perps.read.VERSION(atUpgradeBlock);
  if (postCodeVersion !== TARGET_CODE_VERSION) {
    throw new Error(`Post-upgrade code version ${postCodeVersion}, expected ${TARGET_CODE_VERSION}`);
  }
  for (const expected of legacyPositions) {
    const actual = await perps.read.getUserPosition(
      [expected.participant],
      atUpgradeBlock,
    );
    if (actual.netQuantity !== 0n || actual.netEntryValue !== 0n) {
      throw new Error(`Position was not reset for ${expected.participant}`);
    }
    const [orderIds, pendingFunding, fundingSnapshot] = await Promise.all([
      perps.read.getUserOrders([expected.participant], atUpgradeBlock),
      perps.read.getPendingFunding([expected.participant], atUpgradeBlock),
      pc.getStorageAt({
        address: proxyAddress,
        slot: mappingElementSlot(
          expected.participant,
          FUNDING_SNAPSHOT_MAPPING_SLOT,
        ),
        blockNumber: receipt.blockNumber,
      }),
    ]);
    if (orderIds.length !== 0) {
      throw new Error(`Orders were not reset for ${expected.participant}`);
    }
    if (pendingFunding !== 0n || (fundingSnapshot && BigInt(fundingSnapshot) !== 0n)) {
      throw new Error(`Funding state was not reset for ${expected.participant}`);
    }
    const secondSlot = await pc.getStorageAt({
      address: proxyAddress,
      slot: positionSecondSlot(expected.participant),
      blockNumber: receipt.blockNumber,
    });
    if (secondSlot && BigInt(secondSlot) !== 0n) {
      throw new Error(`Position entry slot was not zeroed for ${expected.participant}`);
    }
  }
  logStep("Init version", postInitVersion.toString());
  logStep("Code version", postCodeVersion);
  logStep("Reset verification", `${legacyPositions.length} participants fully clear`);

  const pointsHookAddress = (process.env.HOOK_ADDRESS ?? "") as Hex;
  if (pointsHookAddress && pointsHookAddress !== zeroAddress) {
    const currentHook = await perps.read.hook();
    if (currentHook.toLowerCase() !== pointsHookAddress.toLowerCase()) {
      logInfo("setHook", { current: currentHook, new: pointsHookAddress });
      await logPrompt("Proceed?");
      const simulation = await perps.simulate.setHook([pointsHookAddress]);
      const hookReceipt = await writeAndWait(deployer, simulation);
      logStep("setHook", txUrl(pc, hookReceipt.transactionHash));
    }
  }

  logSuccess(addrUrl(pc, proxyAddress));
}

main();
