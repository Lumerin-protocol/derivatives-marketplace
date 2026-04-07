import type { PublicClient, WalletClient, Account, Chain } from "viem";
import { erc20Abi } from "viem";
import type pino from "pino";
import { ierc20PermitAbi, ierc5267Abi, hashPowerPerpsDexAbi } from "./abi.ts";
import type { InventoryManager } from "./inventoryManager.ts";

const permitTypes = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/**
 * Deposits the wallet's token balance into the perps contract as collateral
 * using ERC-2612 permit (no prior approval needed).
 */
export async function topUpCollateral(opts: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
  chain: Chain;
  perpsAddress: `0x${string}`;
  inventory: InventoryManager;
  logger: pino.Logger;
}): Promise<void> {
  const { publicClient, walletClient, account, chain, perpsAddress, inventory, logger } = opts;
  const tokenAddr = inventory.collateralTokenAddress;
  if (!tokenAddr || inventory.tokenBalance <= 0n) return;

  const amount = inventory.tokenBalance;
  const owner = account.address;
  logger.info({ amount: amount.toString() }, "topping up collateral");

  const [nameResult, versionResult, nonceResult, eip712DomainResult] = await publicClient.multicall(
    {
      allowFailure: true,
      contracts: [
        {
          address: tokenAddr,
          abi: erc20Abi,
          functionName: "name",
        },
        {
          address: tokenAddr,
          abi: [
            {
              inputs: [],
              name: "version",
              outputs: [{ internalType: "string", name: "", type: "string" }],
              stateMutability: "view",
              type: "function",
            },
          ],
          functionName: "version",
        },
        {
          address: tokenAddr,
          abi: ierc20PermitAbi,
          functionName: "nonces",
          args: [owner],
        },
        {
          address: tokenAddr,
          abi: ierc5267Abi,
          functionName: "eip712Domain",
        },
      ],
    },
  );

  let domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
  if (eip712DomainResult.status === "success") {
    const [, name, version, chainId, verifyingContract] = eip712DomainResult.result;
    domain = {
      name: name,
      version: version,
      chainId: Number(chainId),
      verifyingContract: verifyingContract,
    };
  } else {
    if (nameResult.status === "failure") throw nameResult.error;
    domain = {
      name: nameResult.result,
      version: versionResult.result || "1",
      chainId: chain.id,
      verifyingContract: tokenAddr,
    };
  }

  if (nonceResult.status === "failure") throw nonceResult.error;
  const nonce = nonceResult.result;

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

  const signature = await walletClient.signTypedData({
    account,
    domain,
    types: permitTypes,
    primaryType: "Permit",
    message: { owner, spender: perpsAddress, value: amount, nonce, deadline },
  });

  const r = `0x${signature.slice(2, 66)}` as `0x${string}`;
  const s = `0x${signature.slice(66, 130)}` as `0x${string}`;
  const v = Number.parseInt(signature.slice(130, 132), 16);

  const hash = await walletClient.writeContract({
    address: perpsAddress,
    abi: hashPowerPerpsDexAbi,
    functionName: "addCollateralWithPermit",
    args: [amount, deadline, v, r, s],
    account,
    chain,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  await inventory.update();
  logger.info(
    { collateralBalance: inventory.collateralBalance.toString() },
    "collateral topped up",
  );
}
