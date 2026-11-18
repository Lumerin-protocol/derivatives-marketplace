import { type Address, getAddress, parseAbi, type PublicClient } from "viem";

const SCHEDULED_FEED_ABI = parseAbi(["function hashpriceUsd() view returns (address)"]);

async function indexOf(pc: PublicClient, feed: Address): Promise<Address | undefined> {
  return pc
    .readContract({ address: feed, abi: SCHEDULED_FEED_ABI, functionName: "hashpriceUsd" })
    .then(getAddress)
    .catch(() => undefined);
}

/**
 * The oracle the margin engine stresses at, for a perps venue priced by `feed`: the index behind a
 * scheduled feed (`HashpriceGlideUSD.hashpriceUsd()`), or the feed itself when it is the index.
 */
export async function engineIndexOracle(pc: PublicClient, feed: Address): Promise<Address> {
  const index = (await indexOf(pc, feed)) ?? getAddress(feed);
  if (await indexOf(pc, index)) {
    throw new Error(`Engine oracle ${index} is itself a scheduled feed; the engine must stress at the index`);
  }
  return index;
}
