import { BigInt } from "@graphprotocol/graph-ts/common/numbers";
import { concatU64s } from "./lib";
import { Bytes } from "@graphprotocol/graph-ts/common/collections";

export function blockNumberLogIndex(blockNumber: BigInt, logIndex: BigInt): Bytes {
  return concatU64s(blockNumber.toU64(), logIndex.toU64());
}

export function blockNumberLogIndexAddress(
  blockNumber: BigInt,
  logIndex: BigInt,
  contractAddress: Bytes
): Bytes {
  return blockNumberLogIndex(blockNumber, logIndex).concat(contractAddress);
}
