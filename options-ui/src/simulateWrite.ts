import type {
  Abi,
  Address,
  ContractFunctionArgs,
  ContractFunctionName,
  Hash,
  PublicClient,
  SimulateContractParameters,
  WriteContractParameters,
} from "viem";
import { simulateContract } from "viem/actions";
import { contractErrors } from "./abi/ContractErrors";

/**
 * Run `eth_call` simulation for the wallet account, then send the same calldata.
 * Surfaces revert data from simulation before the user signs.
 */
export async function simulateThenWriteContract<
  const TAbi extends Abi | readonly unknown[],
  TFunctionName extends ContractFunctionName<TAbi, "nonpayable" | "payable">,
  TArgs extends ContractFunctionArgs<TAbi, "nonpayable" | "payable", TFunctionName>,
>(
  publicClient: PublicClient,
  writeContractAsync: (variables: WriteContractParameters) => Promise<Hash>,
  parameters: SimulateContractParameters<TAbi, TFunctionName, TArgs, undefined, undefined, Address>,
): Promise<Hash> {
  const param = {
    ...parameters,
    abi: [...parameters.abi, ...contractErrors],
  } as SimulateContractParameters<TAbi, TFunctionName, TArgs, undefined, undefined, Address>;
  const { request } = await simulateContract(publicClient, param);
  return writeContractAsync(request as WriteContractParameters);
}
