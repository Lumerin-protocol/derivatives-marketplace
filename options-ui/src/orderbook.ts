import type { Address, PublicClient } from "viem";
import { OptionOrderBookAbi } from "./abi/OptionOrderBook";

export type OrderBookLevel = { priceTicks: bigint; totalRemaining: bigint };

export type OrderBookSnapshot = {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  bestBidTick: bigint;
  bestAskTick: bigint;
};

const MULTICALL_CHUNK = 64;

async function sumRemainingAtLevel(
  publicClient: PublicClient,
  book: Address,
  seriesId: bigint,
  isBuy: boolean,
  priceTicks: bigint,
): Promise<bigint> {
  const orderIds: bigint[] = [];
  let cur = await publicClient.readContract({
    address: book,
    abi: OptionOrderBookAbi,
    functionName: "nextOrderInQueue",
    args: [seriesId, isBuy, priceTicks, 0n],
  });
  while (cur !== 0n) {
    orderIds.push(cur);
    cur = await publicClient.readContract({
      address: book,
      abi: OptionOrderBookAbi,
      functionName: "nextOrderInQueue",
      args: [seriesId, isBuy, priceTicks, cur],
    });
  }
  if (orderIds.length === 0) {
    return 0n;
  }
  let total = 0n;
  for (let i = 0; i < orderIds.length; i += MULTICALL_CHUNK) {
    const slice = orderIds.slice(i, i + MULTICALL_CHUNK);
    const res = await publicClient.multicall({
      contracts: slice.map((orderId) => ({
        address: book,
        abi: OptionOrderBookAbi,
        functionName: "getOrder" as const,
        args: [orderId],
      })),
    });
    for (const row of res) {
      if (row.status === "success") {
        total += row.result.size;
      }
    }
  }
  return total;
}

async function walkSide(
  publicClient: PublicClient,
  book: Address,
  seriesId: bigint,
  isBuy: boolean,
  maxLevels: number,
): Promise<OrderBookLevel[]> {
  const levels: OrderBookLevel[] = [];
  const bestFn = isBuy ? ("bestBid" as const) : ("bestAsk" as const);
  const [, firstTick] = await publicClient.readContract({
    address: book,
    abi: OptionOrderBookAbi,
    functionName: bestFn,
    args: [seriesId],
  });
  let tick: bigint = firstTick;
  while (tick !== 0n && levels.length < maxLevels) {
    const totalRemaining = await sumRemainingAtLevel(publicClient, book, seriesId, isBuy, tick);
    if (totalRemaining > 0n) {
      levels.push({ priceTicks: tick, totalRemaining });
    }
    const [nextTick, found] = await publicClient.readContract({
      address: book,
      abi: OptionOrderBookAbi,
      functionName: "nextLevel",
      args: [seriesId, isBuy, tick],
    });
    if (!found || nextTick === 0n) {
      break;
    }
    tick = nextTick;
  }
  return levels;
}

export async function fetchOrderBookSnapshot(
  publicClient: PublicClient,
  book: Address,
  seriesId: bigint,
  maxLevels: number,
): Promise<OrderBookSnapshot> {
  const [bidLevels, askLevels, bb, ba] = await Promise.all([
    walkSide(publicClient, book, seriesId, true, maxLevels),
    walkSide(publicClient, book, seriesId, false, maxLevels),
    publicClient.readContract({
      address: book,
      abi: OptionOrderBookAbi,
      functionName: "bestBid",
      args: [seriesId],
    }),
    publicClient.readContract({
      address: book,
      abi: OptionOrderBookAbi,
      functionName: "bestAsk",
      args: [seriesId],
    }),
  ]);
  return {
    bids: bidLevels,
    asks: askLevels,
    bestBidTick: bb[1],
    bestAskTick: ba[1],
  };
}
