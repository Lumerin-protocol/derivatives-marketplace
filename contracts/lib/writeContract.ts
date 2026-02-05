import type {
  SimulateContractReturnType,
  Account,
  WalletClient,
  Chain,
  Transport,
  Abi,
  WriteContractParameters,
} from "viem";
import { waitForTransactionReceipt, writeContract } from "viem/actions";

export async function writeAndWait(
  walletClient: WalletClient<Transport, Chain, Account>,
  simulateResult: { request: WriteContractParameters }
) {
  const hash = await writeContract(walletClient, simulateResult.request);
  return await waitForTransactionReceipt(walletClient, { hash });
}
