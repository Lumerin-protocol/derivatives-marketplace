import crypto from "node:crypto";
import type { PublicClient } from "@nomicfoundation/hardhat-viem/types";
import {
  type Abi,
  BaseError,
  ContractFunctionRevertedError,
  InvalidInputRpcError,
  UnknownRpcError,
} from "viem";
import { type DecodeErrorResultReturnType, decodeErrorResult, padHex } from "viem/utils";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import { time } from "@nomicfoundation/hardhat-network-helpers";

export async function getTxTimestamp(client: PublicClient, txHash: `0x${string}`): Promise<bigint> {
  const receipt = await client.waitForTransactionReceipt({
    hash: txHash,
    timeout: 1000,
  });
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  return block.timestamp;
}

export async function getTxDeltaTime(
  client: PublicClient,
  txHash: `0x${string}`,
  txHash2: `0x${string}`
): Promise<bigint> {
  const timestamp1 = await getTxTimestamp(client, txHash);
  const timestamp2 = await getTxTimestamp(client, txHash2);
  return timestamp2 - timestamp1;
}

/** helper function to catch errors and check if the error is the expected one
 * @example
 * await catchError(abi, "ErrorName", async () => {
 *   await contract.method();
 * });
 **/
export async function catchError<const TAbi extends Abi | readonly unknown[]>(
  abi: TAbi | undefined,
  error:
    | DecodeErrorResultReturnType<TAbi>["errorName"]
    | DecodeErrorResultReturnType<TAbi>["errorName"][],
  cb: () => Promise<unknown>
) {
  try {
    await cb();
    throw new Error(`No error was thrown, expected error "${error}"`);
  } catch (err) {
    if (Array.isArray(error)) {
      return expectError(err, abi, error);
    }
    return expectError(err, abi, [error]);
  }
}

export function expectError<const TAbi extends Abi | readonly unknown[]>(
  err: any,
  abi: TAbi | undefined,
  errors: DecodeErrorResultReturnType<TAbi>["errorName"][]
) {
  for (const error of errors) {
    if (isErr(err, abi, error)) {
      return;
    }
  }

  throw new Error(
    `Expected one of blockchain custom errors "${errors.join(" | ")}" was not thrown\n\n${err}`,
    { cause: err }
  );
}

export function isErr<const TAbi extends Abi | readonly unknown[]>(
  err: any,
  abi: TAbi | undefined,
  error: DecodeErrorResultReturnType<TAbi>["errorName"]
): boolean {
  if (err instanceof BaseError) {
    const revertError = err.walk((err) => {
      return (
        err instanceof InvalidInputRpcError ||
        err instanceof ContractFunctionRevertedError ||
        err instanceof UnknownRpcError
      );
    });

    // support for regular provider
    if (revertError instanceof ContractFunctionRevertedError) {
      const errorName = revertError.data?.errorName ?? "";
      if (errorName === error) {
        return true;
      }
    }

    // support for hardhat node
    let data: `0x${string}` = "0x";
    if (revertError instanceof InvalidInputRpcError) {
      data = (revertError?.cause as any)?.data?.data;
    } else if (revertError instanceof UnknownRpcError) {
      data = (revertError.cause as any)?.data;
    }

    if (data) {
      try {
        const decodedError = decodeErrorResult({ abi, data });
        if (decodedError.errorName === error) {
          return true;
        }
      } catch (e) {
        return false;
      }
    }
  }

  console.error(err);
  return false;
}

interface BalanceOf {
  read: {
    balanceOf: (a: [`0x${string}`], b?: { blockNumber?: bigint }) => Promise<bigint>;
  };
}

type Account = {
  account: {
    address: `0x${string}`;
  };
};

/** Returns the change of address token balance due to the transaction */
export async function getTxDeltaBalance(
  pc: PublicClient,
  txHash: `0x${string}`,
  address: `0x${string}` | Account,
  token: BalanceOf
): Promise<bigint> {
  const receipt = await pc.waitForTransactionReceipt({ hash: txHash });
  const addressToUse = typeof address === "object" ? address.account.address : address;
  const before = await token.read.balanceOf([addressToUse], {
    blockNumber: receipt.blockNumber - 1n,
  });
  const after = await token.read.balanceOf([addressToUse]);
  return after - before;
}

export const getHex = (buffer: Buffer, padding = 32): `0x${string}` => {
  return padHex(`0x${buffer.toString("hex")}`, { size: padding });
};

export const randomBytes32 = (): `0x${string}` => {
  return getHex(crypto.randomBytes(32));
};

export const randomBytes = (nBytes: number): `0x${string}` => {
  return getHex(crypto.randomBytes(nBytes), nBytes);
};

export const randomAddress = (): `0x${string}` => {
  return getHex(crypto.randomBytes(20), 20);
};

export const now = (): bigint => {
  return BigInt(Math.floor(Date.now() / 1000));
};

export const nowChain = async (): Promise<bigint> => {
  return BigInt(await time.latest());
};

export const NewDate = (timestamp: bigint): Date => {
  return new Date(Number(timestamp) * 1000);
};

export const PanicOutOfBoundsRegexp =
  /.*reverted with panic code 0x32 (Array accessed at an out-of-bounds or negative index)*/;

// set hardhat automine
export const setAutomine = async (
  hre: HardhatRuntimeEnvironment,
  enabled: boolean
): Promise<boolean> => {
  const pc = await hre.viem.getPublicClient();
  return pc.request({ method: "evm_setAutomine", params: [!!enabled] } as any);
};

export const setIntervalMining = async (
  hre: HardhatRuntimeEnvironment,
  interval: number
): Promise<boolean> => {
  const pc = await hre.viem.getPublicClient();
  return pc.request({
    method: "evm_setIntervalMining",
    params: [interval],
  } as any);
};

// mine new block
export const mine = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const pc = await hre.viem.getPublicClient();
  return pc.request({
    method: "evm_mine",
  } as any);
};
