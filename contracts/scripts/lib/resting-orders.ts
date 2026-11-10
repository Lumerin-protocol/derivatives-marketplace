import type { Address, PublicClient } from "viem";
import { readContract } from "viem/actions";
import { HashPowerPerpsDEXAbi } from "../../abi/HashPowerPerpsDEX.ts";

const READ_CONCURRENCY = 16;
const MAX_PRICE_LEVELS_PER_SIDE = 200n;

/** The `candidates` holding at least one resting order at `blockNumber`. */
export async function usersWithRestingOrders(
  pc: PublicClient,
  perps: Address,
  candidates: readonly Address[],
  blockNumber: bigint,
): Promise<Address[]> {
  const counts = await mapConcurrently(candidates, async (user) => {
    const ids = await readContract(pc, {
      address: perps,
      abi: HashPowerPerpsDEXAbi,
      functionName: "getUserOrders",
      args: [user],
      blockNumber,
    });
    return ids.length;
  });
  return candidates.filter((_, i) => counts[i] > 0);
}

/** Throws unless the book is empty and every listed user has no orders and a zero aggregate. */
export async function assertNoRestingOrders(
  pc: PublicClient,
  perps: Address,
  users: readonly Address[],
  blockNumber: bigint,
): Promise<void> {
  const [bids, asks] = await readContract(pc, {
    address: perps,
    abi: HashPowerPerpsDEXAbi,
    functionName: "getOrderBookPrices",
    args: [MAX_PRICE_LEVELS_PER_SIDE],
    blockNumber,
  });
  if (bids.length + asks.length > 0) {
    throw new Error(`Book still has ${bids.length} bid and ${asks.length} ask levels`);
  }
  await mapConcurrently(users, async (user) => {
    const [ids, aggregate] = await Promise.all([
      readContract(pc, {
        address: perps,
        abi: HashPowerPerpsDEXAbi,
        functionName: "getUserOrders",
        args: [user],
        blockNumber,
      }),
      readContract(pc, {
        address: perps,
        abi: HashPowerPerpsDEXAbi,
        functionName: "getOrderAggregate",
        args: [user],
        blockNumber,
      }),
    ]);
    if (ids.length > 0 || Object.values(aggregate).some((value) => value !== 0n)) {
      throw new Error(`${user} still has ${ids.length} order(s) or a nonzero aggregate`);
    }
  });
}

export function chunk<T>(values: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < values.length; i += size) batches.push(values.slice(i, i + size));
  return batches;
}

async function mapConcurrently<T, R>(values: readonly T[], fn: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await fn(values[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, values.length) }, worker));
  return results;
}
