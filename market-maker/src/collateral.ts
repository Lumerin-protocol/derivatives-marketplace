import type pino from "pino";
import { IERC20PermitAbi as ierc20PermitAbi } from "../../contracts/abi/IERC20Permit.ts";
import { IERC5267Abi as ierc5267Abi } from "../../contracts/abi/IERC5267.ts";
import { HashPowerPerpsDEXAbi as hashPowerPerpsDexAbi } from "../../contracts/abi/HashPowerPerpsDEX.ts";
import { CollateralVaultAbi as collateralVaultAbi } from "../../contracts/abi/CollateralVault.ts";
import type { PublicClient, WalletClient, Account, Chain } from "./client.ts";
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
 * Deposits the wallet's token balance into the CollateralVault as collateral
 * using ERC-2612 permit (no prior approval needed). The spender on the permit
 * is the vault itself, since the vault pulls the underlying token in `depositForPermit`.
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

  const [vaultAddress, domain, nonce] = await publicClient.multicall({
    allowFailure: false,
    contracts: [
      {
        address: perpsAddress,
        abi: hashPowerPerpsDexAbi,
        functionName: "vault",
      },
      {
        address: tokenAddr,
        abi: ierc5267Abi,
        functionName: "eip712Domain",
      },
      {
        address: tokenAddr,
        abi: ierc20PermitAbi,
        functionName: "nonces",
        args: [owner],
      },
    ],
  });

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

  const signature = await walletClient.signTypedData({
    account,
    domain: {
      name: domain[1],
      version: domain[2],
      chainId: domain[3],
      verifyingContract: domain[4],
    },
    types: permitTypes,
    primaryType: "Permit",
    message: { owner, spender: vaultAddress, value: amount, nonce, deadline },
  });

  const r = `0x${signature.slice(2, 66)}` as `0x${string}`;
  const s = `0x${signature.slice(66, 130)}` as `0x${string}`;
  const v = Number.parseInt(signature.slice(130, 132), 16);

  const hash = await walletClient.writeContract({
    address: vaultAddress,
    abi: collateralVaultAbi,
    functionName: "depositForPermit",
    args: [owner, amount, deadline, v, r, s],
    account,
    chain,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  await inventory.update();
  logger.info({ collateralBalance: inventory.collateralBalance.toString() }, "collateral topped up");
}
