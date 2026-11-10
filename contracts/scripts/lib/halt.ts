import { OperationType } from "@safe-global/types-kit";
import {
  type Account,
  type Address,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
  encodeFunctionData,
  getAddress,
  parseAbi,
} from "viem";
import { requireEnvsSet } from "../../lib/env.ts";
import { txUrl } from "../../lib/explorer.ts";
import { logPrompt, logStep } from "../../lib/log.ts";
import { SafeWallet } from "../../lib/safe.ts";

type Wallet = WalletClient<Transport, Chain, Account>;

const VAULT_ABI = parseAbi([
  "function halted() view returns (bool)",
  "function owner() view returns (address)",
  "function halt()",
]);
const POLL_INTERVAL_MS = 15_000;

/**
 * Make sure the shared vault is halted, so no order is placed, filled or backed by a
 * withdrawal while the upgrade runs. Halts directly when `sender` owns the vault; otherwise
 * proposes `halt()` to the owning Safe through `proposer` and waits until it executes.
 * Returns a block at which the vault is halted.
 */
export async function ensureVaultHalted(
  pc: PublicClient,
  vault: Address,
  sender: Wallet,
  proposer: Wallet = sender,
): Promise<bigint> {
  const haltedAt = async (): Promise<bigint | undefined> => {
    const blockNumber = await pc.getBlockNumber();
    const halted = await pc.readContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: "halted",
      blockNumber,
    });
    return halted ? blockNumber : undefined;
  };
  let block = await haltedAt();
  if (block === undefined) {
    const owner = getAddress(
      await pc.readContract({ address: vault, abi: VAULT_ABI, functionName: "owner" }),
    );
    if (owner === getAddress(sender.account.address)) {
      await logPrompt(`Halt vault ${vault}? It stops new orders and withdrawals on every venue.`);
      const hash = await sender.writeContract({ address: vault, abi: VAULT_ABI, functionName: "halt" });
      const receipt = await pc.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`halt reverted: ${txUrl(pc, hash)}`);
      logStep("halt vault", txUrl(pc, hash));
    } else {
      const { SAFE_API_KEY } = requireEnvsSet("SAFE_API_KEY");
      const safe = new SafeWallet(owner, proposer, SAFE_API_KEY);
      await logPrompt(`Vault is not halted. Propose halt() to its owner Safe ${owner}?`);
      const safeTxHash = await safe.proposeTransaction({
        data: encodeFunctionData({ abi: VAULT_ABI, functionName: "halt" }),
        to: vault,
        value: "0",
        operation: OperationType.Call,
      });
      logStep("halt proposed", safe.getSafeUITxUrl(safeTxHash));
    }
    block = await haltedAt();
  }
  while (block === undefined) {
    if (process.stdin.isTTY) {
      await logPrompt("Vault is not halted yet. Execute the halt, then continue");
    } else {
      logStep("vault", `not halted yet; checking again in ${POLL_INTERVAL_MS / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    block = await haltedAt();
  }
  logStep("vault", `halted at block ${block}`);
  return block;
}
