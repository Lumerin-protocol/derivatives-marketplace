import { useCallback, useEffect, useMemo, useState } from "react";
import { erc20Abi, formatUnits, isAddress, maxUint256, parseUnits } from "viem";
import {
  useAccount,
  useChainId,
  useConnect,
  useDisconnect,
  usePublicClient,
  useReadContract,
  useReadContracts,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { injected } from "wagmi/connectors";

import { fetchOrderBookSnapshot, type OrderBookSnapshot } from "./orderbook.ts";
import { simulateThenWriteContract } from "./simulateWrite.ts";
import {
  buildChainRows,
  formatStrikeUsd,
  midPremiumE8,
  premiumFromTicks,
  priceTicksFromPremiumInput,
  statusLabel,
  type ChainRow,
  type SeriesMeta,
  uniqueExpiriesSorted,
} from "./seriesCatalog.ts";
import { targetChain } from "./wagmi.ts";
import { OptionMatchingRouterAbi } from "./abi/OptionMatchingRouter.ts";
import { OptionOrderBookAbi } from "./abi/OptionOrderBook.ts";
import { OptionMarginEngineAbi } from "./abi/OptionMarginEngine.ts";
import { OptionMarketRegistryAbi } from "./abi/OptionMarketRegistry.ts";

const BOOK_MAX_LEVELS = 12;
const POLL_MS = 4_000;

export function App() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { connect, isPending: connectPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switchPending } = useSwitchChain();

  const registryAddr = import.meta.env.OPTION_REGISTRY_ADDRESS;
  const engineAddr = import.meta.env.OPTION_MARGIN_ENGINE_ADDRESS;
  const routerAddr = import.meta.env.OPTION_MATCHING_ROUTER_ADDRESS;
  const vaultAddr = import.meta.env.VAULT_ADDRESS;
  const usdcAddr = import.meta.env.COLLATERAL_TOKEN_ADDRESS;

  const addrsOk =
    isAddress(registryAddr) &&
    isAddress(engineAddr) &&
    isAddress(routerAddr) &&
    isAddress(vaultAddr) &&
    isAddress(usdcAddr);

  const wrongNetwork = isConnected && chainId !== targetChain.id;
  /** Reads use the wallet’s chain; block when connected on a non-Hardhat network. */
  const rpcOk = addrsOk && !wrongNetwork;

  const { data: nextSeriesIdBn, isPending: nextSeriesIdPending } = useReadContract({
    address: registryAddr,
    abi: OptionMarketRegistryAbi,
    functionName: "nextSeriesId",
    query: { enabled: rpcOk },
  });

  const idUpperExclusive =
    nextSeriesIdBn !== undefined && nextSeriesIdBn > 1n ? nextSeriesIdBn - 1n : 0n;

  const idList = useMemo(() => {
    if (idUpperExclusive === 0n) {
      return [];
    }
    const ids: bigint[] = [];
    for (let i = 1n; i <= idUpperExclusive; i++) {
      ids.push(i);
    }
    return ids;
  }, [idUpperExclusive]);

  const { data: seriesReads, isPending: seriesReadsPending } = useReadContracts({
    contracts: idList.map((seriesId) => ({
      address: registryAddr,
      abi: OptionMarketRegistryAbi,
      functionName: "getSeries" as const,
      args: [seriesId],
    })),
    query: {
      enabled: rpcOk && idList.length > 0,
      refetchInterval: POLL_MS,
    },
  });

  const catalog: SeriesMeta[] = useMemo(() => {
    const out: SeriesMeta[] = [];
    if (!seriesReads) {
      return out;
    }
    for (let i = 0; i < seriesReads.length; i++) {
      const r = seriesReads[i];
      if (r.status !== "success") {
        continue;
      }
      const t = r.result;
      out.push({
        seriesId: idList[i],
        strikeE8: t.strikeE8,
        expiryTs: t.expiryTs,
        isCall: t.isCall,
        tickSizeE8: t.tickSizeE8,
        lotSize: t.lotSize,
        status: t.status,
      });
    }
    return out;
  }, [seriesReads, idList]);

  const chainRows = useMemo(() => buildChainRows(catalog), [catalog]);
  const expiries = useMemo(() => uniqueExpiriesSorted(chainRows), [chainRows]);

  const [selectedExpiry, setSelectedExpiry] = useState<bigint | null>(null);
  useEffect(() => {
    if (expiries.length === 0) {
      return;
    }
    setSelectedExpiry((prev) => {
      if (prev !== null && expiries.some((e) => e === prev)) {
        return prev;
      }
      return expiries[0];
    });
  }, [expiries]);

  const rowsForExpiry = useMemo(() => {
    if (selectedExpiry === null) {
      return [];
    }
    return chainRows.filter((r) => r.expiryTs === selectedExpiry);
  }, [chainRows, selectedExpiry]);

  const [selectedSeriesId, setSelectedSeriesId] = useState<bigint | null>(null);
  const [selectedSide, setSelectedSide] = useState<"call" | "put" | null>(null);

  useEffect(() => {
    if (catalog.length === 0 || selectedExpiry === null) {
      return;
    }
    if (selectedSeriesId !== null) {
      const stillThere = catalog.some(
        (c) => c.seriesId === selectedSeriesId && c.expiryTs === selectedExpiry,
      );
      if (stillThere) {
        return;
      }
    }
    const rows = chainRows.filter((r) => r.expiryTs === selectedExpiry);
    for (const row of rows) {
      for (const id of [row.callSeriesId, row.putSeriesId]) {
        if (id === null) {
          continue;
        }
        const m = catalog.find((c) => c.seriesId === id);
        if (m?.status === 1) {
          setSelectedSeriesId(id);
          setSelectedSide(m.isCall ? "call" : "put");
          return;
        }
      }
    }
    const first = rows[0];
    if (first) {
      const id = first.callSeriesId ?? first.putSeriesId;
      if (id !== null) {
        setSelectedSeriesId(id);
        const m = catalog.find((c) => c.seriesId === id);
        setSelectedSide(m?.isCall ? "call" : "put");
      }
    }
  }, [catalog, chainRows, selectedExpiry, selectedSeriesId]);

  const selectedMeta = useMemo(
    () =>
      selectedSeriesId === null ? undefined : catalog.find((c) => c.seriesId === selectedSeriesId),
    [catalog, selectedSeriesId],
  );

  const { data: bookAddr_ } = useReadContract({
    address: routerAddr,
    abi: OptionMatchingRouterAbi,
    functionName: "book",
    query: { enabled: rpcOk },
  });
  const bookAddr = bookAddr_ && isAddress(bookAddr_) ? bookAddr_ : undefined;

  const seriesIdsForQuotes = useMemo(() => {
    const ids: bigint[] = [];
    for (const r of rowsForExpiry) {
      if (r.callSeriesId !== null) {
        ids.push(r.callSeriesId);
      }
      if (r.putSeriesId !== null) {
        ids.push(r.putSeriesId);
      }
    }
    return ids;
  }, [rowsForExpiry]);

  const quoteContracts = useMemo(() => {
    if (!bookAddr || !rpcOk) {
      return [];
    }
    return seriesIdsForQuotes.flatMap((seriesId) => [
      {
        address: bookAddr,
        abi: OptionOrderBookAbi,
        functionName: "bestBid" as const,
        args: [seriesId],
      },
      {
        address: bookAddr,
        abi: OptionOrderBookAbi,
        functionName: "bestAsk" as const,
        args: [seriesId],
      },
    ]);
  }, [bookAddr, rpcOk, seriesIdsForQuotes]);

  const { data: quoteReads, refetch: refetchQuotes } = useReadContracts({
    contracts: quoteContracts,
    query: {
      enabled: quoteContracts.length > 0 && rpcOk,
      refetchInterval: POLL_MS,
    },
  });

  const quotesBySeriesId = useMemo(() => {
    const m = new Map<bigint, { bid: bigint; ask: bigint }>();
    if (!quoteReads || seriesIdsForQuotes.length === 0) {
      return m;
    }
    for (let i = 0; i < seriesIdsForQuotes.length; i++) {
      const seriesId = seriesIdsForQuotes[i];
      const bidIx = i * 2;
      const askIx = i * 2 + 1;
      const b = quoteReads[bidIx];
      const a = quoteReads[askIx];
      if (b?.status === "success" && a?.status === "success") {
        const br = b.result as readonly [bigint, bigint];
        const ar = a.result as readonly [bigint, bigint];
        m.set(seriesId, { bid: br[1], ask: ar[1] });
      }
    }
    return m;
  }, [quoteReads, seriesIdsForQuotes]);

  const { data: tokenFromEngine } = useReadContract({
    address: engineAddr,
    abi: OptionMarginEngineAbi,
    functionName: "collateralToken",
    query: { enabled: rpcOk && isAddress(engineAddr) },
  });

  const usdcEffective = tokenFromEngine && isAddress(tokenFromEngine) ? tokenFromEngine : usdcAddr;

  const { data: decimals } = useReadContract({
    address: usdcEffective,
    abi: erc20Abi,
    functionName: "decimals",
    query: { enabled: rpcOk && isAddress(usdcEffective) },
  });

  const tokenDecimals = decimals ?? 6;

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: usdcEffective,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, vaultAddr] : undefined,
    query: { enabled: Boolean(address) && rpcOk && isAddress(usdcEffective) },
  });

  const { data: liveReads, refetch: refetchLive } = useReadContracts({
    contracts:
      address && rpcOk && selectedSeriesId !== null
        ? [
            {
              address: usdcEffective,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [address],
            },
            {
              address: engineAddr,
              abi: OptionMarginEngineAbi,
              functionName: "getCollateral",
              args: [address],
            },
            {
              address: engineAddr,
              abi: OptionMarginEngineAbi,
              functionName: "getPosition",
              args: [address, selectedSeriesId],
            },
          ]
        : address && rpcOk
          ? [
              {
                address: usdcEffective,
                abi: erc20Abi,
                functionName: "balanceOf",
                args: [address],
              },
              {
                address: engineAddr,
                abi: OptionMarginEngineAbi,
                functionName: "getCollateral",
                args: [address],
              },
            ]
          : [],
    query: {
      enabled: Boolean(address) && rpcOk,
      refetchInterval: POLL_MS,
    },
  });

  const walletUsdc = liveReads?.[0]?.status === "success" ? liveReads[0].result : undefined;
  const collateralWad = liveReads?.[1]?.status === "success" ? liveReads[1].result : undefined;
  const positionQty =
    liveReads?.length === 3 && liveReads[2]?.status === "success" ? liveReads[2].result : undefined;

  const [bookSnap, setBookSnap] = useState<OrderBookSnapshot | null>(null);
  const [bookErr, setBookErr] = useState<string | null>(null);

  const loadBook = useCallback(async () => {
    if (wrongNetwork || !publicClient || !bookAddr || selectedSeriesId === null) {
      setBookSnap(null);
      return;
    }
    try {
      setBookErr(null);
      const snap = await fetchOrderBookSnapshot(
        publicClient,
        bookAddr,
        selectedSeriesId,
        BOOK_MAX_LEVELS,
      );
      setBookSnap(snap);
    } catch (e) {
      setBookErr(e instanceof Error ? e.message : String(e));
      setBookSnap(null);
    }
  }, [wrongNetwork, publicClient, bookAddr, selectedSeriesId]);

  useEffect(() => {
    void loadBook();
  }, [loadBook]);

  useEffect(() => {
    if (wrongNetwork || !publicClient || !bookAddr || selectedSeriesId === null) {
      return;
    }
    const t = setInterval(() => void loadBook(), POLL_MS);
    return () => clearInterval(t);
  }, [loadBook, wrongNetwork, publicClient, bookAddr, selectedSeriesId]);

  const [depositStr, setDepositStr] = useState("1000");
  const [withdrawStr, setWithdrawStr] = useState("100");
  const [pricePremiumStr, setPricePremiumStr] = useState("1");
  const [sizeContractsStr, setSizeContractsStr] = useState("1");
  const [orderSideBuy, setOrderSideBuy] = useState(true);
  const [postOnly, setPostOnly] = useState(false);
  /** Simulation failures (or other throws before/at write) — hook `writeError` only covers the wallet send. */
  const [actionError, setActionError] = useState<string | null>(null);

  const {
    writeContractAsync,
    data: txHash,
    isPending: writePending,
    error: writeError,
  } = useWriteContract();
  const { isLoading: txConfirming, isSuccess: txSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  const bumpQueries = useCallback(() => {
    void refetchLive();
    void refetchAllowance();
    void refetchQuotes();
    void loadBook();
  }, [refetchLive, refetchAllowance, refetchQuotes, loadBook]);

  useEffect(() => {
    if (txSuccess) {
      setActionError(null);
      bumpQueries();
    }
  }, [txSuccess, bumpQueries]);

  useEffect(() => {
    if (writeError) {
      console.error("[options-ui] writeContract failed:", writeError);
    }
  }, [writeError]);

  const runSimulatedTx = useCallback(
    async (fn: () => ReturnType<typeof simulateThenWriteContract>) => {
      setActionError(null);
      try {
        await fn();
      } catch (e) {
        console.error("[options-ui] simulated tx failed:", e);
        setActionError(e instanceof Error ? e.message : String(e));
      }
    },
    [],
  );

  const approveUsdc = async () => {
    if (!address || !isAddress(usdcEffective) || !publicClient) {
      return;
    }
    await runSimulatedTx(() =>
      simulateThenWriteContract(publicClient, writeContractAsync, {
        account: address,
        address: usdcEffective,
        abi: erc20Abi,
        functionName: "approve",
        args: [vaultAddr, maxUint256],
      }),
    );
  };

  const deposit = async () => {
    if (!address || !publicClient) {
      return;
    }
    const amt = parseUnits(depositStr || "0", tokenDecimals);
    if (amt === 0n) {
      return;
    }
    await runSimulatedTx(() =>
      simulateThenWriteContract(publicClient, writeContractAsync, {
        account: address,
        address: engineAddr,
        abi: OptionMarginEngineAbi,
        functionName: "deposit",
        args: [amt],
      }),
    );
  };

  const withdraw = async () => {
    if (!address || !publicClient) {
      return;
    }
    const amt = parseUnits(withdrawStr || "0", tokenDecimals);
    if (amt === 0n) {
      return;
    }
    await runSimulatedTx(() =>
      simulateThenWriteContract(publicClient, writeContractAsync, {
        account: address,
        address: engineAddr,
        abi: OptionMarginEngineAbi,
        functionName: "withdraw",
        args: [amt],
      }),
    );
  };

  const submitOrder = async () => {
    if (selectedSeriesId === null || selectedMeta === undefined || !address || !publicClient) {
      return;
    }
    const priceTicks = priceTicksFromPremiumInput(pricePremiumStr, selectedMeta.tickSizeE8);
    if (priceTicks === null) {
      return;
    }
    const lot = BigInt(selectedMeta.lotSize);
    const contracts = BigInt(sizeContractsStr || "0");
    const size = contracts * lot;
    if (size === 0n) {
      return;
    }
    await runSimulatedTx(() =>
      simulateThenWriteContract(publicClient, writeContractAsync, {
        account: address,
        address: routerAddr,
        abi: OptionMatchingRouterAbi,
        functionName: "submitOrder",
        args: [
          {
            seriesId: selectedSeriesId,
            isBuy: orderSideBuy,
            priceTicks,
            size,
            orderType: 0,
            postOnly,
            reduceOnly: false,
          },
        ],
      }),
    );
  };

  const selectInstrument = (row: ChainRow, side: "call" | "put") => {
    const id = side === "call" ? row.callSeriesId : row.putSeriesId;
    if (id === null) {
      return;
    }
    setSelectedSeriesId(id);
    setSelectedSide(side);
  };

  const premiumParse = useMemo(() => {
    if (selectedMeta === undefined) {
      return { ticks: null as bigint | null, tickSizeLabel: "" };
    }
    const ts = selectedMeta.tickSizeE8;
    const tickSizeLabel = formatUnits(BigInt(ts), 8);
    return {
      ticks: priceTicksFromPremiumInput(pricePremiumStr, ts),
      tickSizeLabel,
    };
  }, [selectedMeta, pricePremiumStr]);

  const detailMid =
    selectedMeta && bookSnap
      ? midPremiumE8(bookSnap.bestBidTick, bookSnap.bestAskTick, selectedMeta.tickSizeE8)
      : null;

  const tradeDisabled =
    !isConnected ||
    wrongNetwork ||
    !addrsOk ||
    writePending ||
    selectedSeriesId === null ||
    selectedMeta?.status !== 1 ||
    premiumParse.ticks === null;

  const formatExpiry = (ts: bigint) =>
    new Date(Number(ts) * 1000).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });

  function quoteCell(seriesId: bigint | null, tickSizeE8: number) {
    if (seriesId === null) {
      return "—";
    }
    const q = quotesBySeriesId.get(seriesId);
    if (!q) {
      return "…";
    }
    const bid = q.bid === 0n ? "—" : premiumFromTicks(q.bid, tickSizeE8);
    const ask = q.ask === 0n ? "—" : premiumFromTicks(q.ask, tickSizeE8);
    const mid = midPremiumE8(q.bid, q.ask, tickSizeE8);
    return (
      <div className="text-[11px] leading-tight">
        <div>
          <span className="text-zinc-500">bid</span> {bid}
        </div>
        <div>
          <span className="text-zinc-500">ask</span> {ask}
        </div>
        {mid ? (
          <div className="text-zinc-400">
            <span className="text-zinc-500">mid</span> {mid}
          </div>
        ) : null}
      </div>
    );
  }

  const lotSize = selectedMeta?.lotSize ?? 0;

  const registryHasNoSeries =
    rpcOk && !nextSeriesIdPending && nextSeriesIdBn !== undefined && nextSeriesIdBn <= 1n;

  const catalogBootloading =
    rpcOk &&
    !nextSeriesIdPending &&
    idList.length > 0 &&
    seriesReadsPending &&
    catalog.length === 0;

  return (
    <div className="mx-auto max-w-6xl p-6 text-zinc-100">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-zinc-800 pb-4">
        <h1 className="text-lg font-semibold tracking-tight">Options</h1>
        <div className="flex flex-wrap items-center gap-2">
          {!isConnected ? (
            <button
              type="button"
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              disabled={connectPending}
              onClick={() => connect({ connector: injected(), chainId: targetChain.id })}
            >
              {connectPending ? "Connecting…" : "Connect"}
            </button>
          ) : (
            <>
              <span className="max-w-[200px] truncate font-mono text-xs text-zinc-400">
                {address}
              </span>
              <button
                type="button"
                className="rounded border border-zinc-600 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                onClick={() => disconnect()}
              >
                Disconnect
              </button>
            </>
          )}
          {chainId !== targetChain.id ? (
            <button
              type="button"
              className="rounded-lg bg-amber-600 px-2 py-1 text-xs font-medium text-white hover:bg-amber-500 disabled:opacity-50"
              disabled={switchPending}
              onClick={() => switchChain({ chainId: targetChain.id })}
            >
              Switch to {targetChain.name}
            </button>
          ) : (
            <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-emerald-400">
              {targetChain.id}
            </span>
          )}
          <button
            type="button"
            className="text-xs text-emerald-500 hover:underline"
            onClick={() => bumpQueries()}
          >
            Refresh
          </button>
        </div>
      </header>

      {actionError || writeError ? (
        <div
          role="alert"
          className="mb-6 rounded-lg border border-red-600 bg-red-950/50 px-4 py-3 text-sm"
        >
          <p className="font-medium text-red-200">Transaction error</p>
          {actionError ? (
            <p className="mt-2 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-red-100/95">
              {actionError}
            </p>
          ) : null}
          {writeError ? (
            <p className="mt-2 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-red-100/95">
              {writeError.message}
            </p>
          ) : null}
        </div>
      ) : null}

      {wrongNetwork ? (
        <div
          role="alert"
          className="mb-6 rounded-lg border border-amber-600 bg-amber-950/50 px-4 py-3 text-sm"
        >
          <p className="font-medium text-amber-100">Wrong network</p>
          <p className="mt-1 text-amber-200/90">
            This app uses <span className="font-mono">{targetChain.name}</span> only (chain ID{" "}
            <span className="font-mono">{targetChain.id}</span>). Add the network in your wallet if
            needed, then switch.
          </p>
          <button
            type="button"
            className="mt-3 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50"
            disabled={switchPending}
            onClick={() => switchChain({ chainId: targetChain.id })}
          >
            {switchPending ? "Switching…" : `Switch to ${targetChain.name}`}
          </button>
        </div>
      ) : null}

      {!addrsOk ? (
        <p className="text-sm text-amber-400">
          Set contract addresses in repo-root <span className="font-mono">.env.local</span> (see{" "}
          <span className="font-mono">pnpm deploy-local</span>).
        </p>
      ) : null}

      {addrsOk && nextSeriesIdPending ? (
        <p className="text-sm text-zinc-500">Loading registry…</p>
      ) : null}

      {registryHasNoSeries ? (
        <p className="text-sm text-zinc-500">No option series on registry yet.</p>
      ) : null}

      {catalogBootloading ? <p className="text-sm text-zinc-500">Loading option series…</p> : null}

      {catalog.length > 0 ? (
        <section className="mb-8 overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/40">
          <div className="flex flex-wrap gap-1 border-b border-zinc-800 p-2">
            {expiries.map((e) => (
              <button
                key={e.toString()}
                type="button"
                className={`rounded px-3 py-1 text-xs ${
                  selectedExpiry === e
                    ? "bg-zinc-700 text-white"
                    : "text-zinc-400 hover:bg-zinc-800"
                }`}
                onClick={() => setSelectedExpiry(e)}
              >
                {formatExpiry(e)}
              </button>
            ))}
          </div>
          <table className="w-full min-w-[640px] table-fixed border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-500">
                <th className="w-[38%] p-2 font-medium" title="Calls — premium in USDC">
                  Call
                </th>
                <th className="w-[24%] p-2 text-center font-medium">Strike</th>
                <th className="w-[38%] p-2 font-medium" title="Puts — premium in USDC">
                  Put
                </th>
              </tr>
            </thead>
            <tbody>
              {rowsForExpiry.map((row) => {
                const callMeta = row.callSeriesId
                  ? catalog.find((c) => c.seriesId === row.callSeriesId)
                  : undefined;
                const putMeta = row.putSeriesId
                  ? catalog.find((c) => c.seriesId === row.putSeriesId)
                  : undefined;
                const callTs = callMeta?.tickSizeE8 ?? putMeta?.tickSizeE8 ?? 1;
                const putTs = putMeta?.tickSizeE8 ?? callMeta?.tickSizeE8 ?? 1;
                const callActive = callMeta?.status === 1;
                const putActive = putMeta?.status === 1;
                const callSel =
                  selectedSeriesId !== null &&
                  row.callSeriesId === selectedSeriesId &&
                  selectedSide === "call";
                const putSel =
                  selectedSeriesId !== null &&
                  row.putSeriesId === selectedSeriesId &&
                  selectedSide === "put";
                return (
                  <tr key={row.key} className="border-b border-zinc-800/80">
                    <td className="min-w-0 p-2 align-top">
                      {row.callSeriesId === null ? (
                        <span className="text-zinc-600">—</span>
                      ) : (
                        <button
                          type="button"
                          disabled={!callActive}
                          className={`w-full rounded border px-2 py-1 text-left transition ${
                            callSel
                              ? "border-sky-500 bg-sky-950/50"
                              : "border-zinc-700 bg-zinc-900 hover:border-zinc-500"
                          } disabled:cursor-not-allowed disabled:opacity-40`}
                          onClick={() => selectInstrument(row, "call")}
                        >
                          <div className="font-mono text-zinc-500">
                            #{row.callSeriesId.toString()}
                          </div>
                          {quoteCell(row.callSeriesId, callTs)}
                          {callMeta ? (
                            <div className="mt-1 text-[10px] text-zinc-500">
                              {statusLabel(callMeta.status)}
                            </div>
                          ) : null}
                        </button>
                      )}
                    </td>
                    <td className="min-w-0 p-2 text-center align-middle font-mono text-sm text-zinc-200">
                      {formatStrikeUsd(row.strikeE8)}
                    </td>
                    <td className="min-w-0 p-2 align-top">
                      {row.putSeriesId === null ? (
                        <span className="text-zinc-600">—</span>
                      ) : (
                        <button
                          type="button"
                          disabled={!putActive}
                          className={`w-full rounded border px-2 py-1 text-left transition ${
                            putSel
                              ? "border-sky-500 bg-sky-950/50"
                              : "border-zinc-700 bg-zinc-900 hover:border-zinc-500"
                          } disabled:cursor-not-allowed disabled:opacity-40`}
                          onClick={() => selectInstrument(row, "put")}
                        >
                          <div className="font-mono text-zinc-500">
                            #{row.putSeriesId.toString()}
                          </div>
                          {quoteCell(row.putSeriesId, putTs)}
                          {putMeta ? (
                            <div className="mt-1 text-[10px] text-zinc-500">
                              {statusLabel(putMeta.status)}
                            </div>
                          ) : null}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <h2 className="mb-2 text-sm font-medium text-zinc-300">Order book</h2>
          {!bookAddr ? <p className="text-xs text-zinc-500">Loading book address…</p> : null}
          {bookErr ? <p className="text-xs text-red-400">{bookErr}</p> : null}
          {selectedMeta ? (
            <p className="mb-2 text-xs text-zinc-500">
              Series #{selectedSeriesId?.toString()} · {selectedMeta.isCall ? "Call" : "Put"} ·{" "}
              {statusLabel(selectedMeta.status)} · Mid {detailMid ?? "—"}
            </p>
          ) : (
            <p className="text-xs text-zinc-500">Select a contract in the chain table.</p>
          )}
          {bookSnap && selectedMeta ? (
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <div className="mb-1 text-zinc-500">Bids</div>
                <ul className="max-h-48 space-y-1 overflow-auto font-mono">
                  {bookSnap.bids.map((l) => (
                    <li key={`b-${l.priceTicks.toString()}`} className="flex justify-between gap-2">
                      <span>{premiumFromTicks(l.priceTicks, selectedMeta.tickSizeE8)}</span>
                      <span className="text-zinc-400">
                        {(l.totalRemaining / BigInt(selectedMeta.lotSize)).toString()}×
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <div className="mb-1 text-zinc-500">Asks</div>
                <ul className="max-h-48 space-y-1 overflow-auto font-mono">
                  {bookSnap.asks.map((l) => (
                    <li key={`a-${l.priceTicks.toString()}`} className="flex justify-between gap-2">
                      <span>{premiumFromTicks(l.priceTicks, selectedMeta.tickSizeE8)}</span>
                      <span className="text-zinc-400">
                        {(l.totalRemaining / BigInt(selectedMeta.lotSize)).toString()}×
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}
        </section>

        <section className="space-y-4">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
            <h2 className="mb-2 text-sm font-medium text-zinc-300">Trade</h2>
            {!isConnected ? <p className="text-xs text-zinc-500">Connect to trade.</p> : null}
            <div className="mb-3 flex gap-2">
              <button
                type="button"
                className={`flex-1 rounded py-2 text-sm font-medium ${
                  orderSideBuy
                    ? "bg-emerald-700 text-white"
                    : "border border-zinc-600 text-zinc-300"
                }`}
                onClick={() => setOrderSideBuy(true)}
              >
                Buy
              </button>
              <button
                type="button"
                className={`flex-1 rounded py-2 text-sm font-medium ${
                  !orderSideBuy ? "bg-rose-800 text-white" : "border border-zinc-600 text-zinc-300"
                }`}
                onClick={() => setOrderSideBuy(false)}
              >
                Sell
              </button>
            </div>
            <div className="flex flex-wrap gap-3">
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-zinc-500">Limit premium (USDC)</span>
                <input
                  className="w-40 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono"
                  value={pricePremiumStr}
                  onChange={(e) => setPricePremiumStr(e.target.value)}
                  inputMode="decimal"
                  spellCheck={false}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-zinc-500">Size (contracts)</span>
                <input
                  className="w-32 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono"
                  value={sizeContractsStr}
                  onChange={(e) => setSizeContractsStr(e.target.value)}
                  spellCheck={false}
                />
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={postOnly}
                  onChange={(e) => setPostOnly(e.target.checked)}
                />
                Post-only
              </label>
            </div>
            {selectedMeta ? (
              <p className="mt-2 text-xs text-zinc-500">
                Tick size {premiumParse.tickSizeLabel} USDC · lot {lotSize.toString()} raw ·{" "}
                {premiumParse.ticks !== null ? (
                  <span className="font-mono text-zinc-400">
                    {premiumParse.ticks.toString()} ticks
                  </span>
                ) : pricePremiumStr.trim() !== "" ? (
                  <span className="text-amber-400">
                    multiple of {premiumParse.tickSizeLabel} required
                  </span>
                ) : (
                  <span className="text-zinc-600">enter premium</span>
                )}
              </p>
            ) : null}
            <button
              type="button"
              className="mt-3 w-full rounded-lg bg-sky-700 py-2 text-sm font-medium hover:bg-sky-600 disabled:opacity-40"
              disabled={tradeDisabled}
              onClick={() => void submitOrder()}
            >
              Submit limit
            </button>
            {selectedMeta?.status !== 1 ? (
              <p className="mt-2 text-xs text-amber-400">Series is not active for trading.</p>
            ) : null}
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
            <h2 className="mb-2 text-sm font-medium text-zinc-300">Collateral</h2>
            {isConnected ? (
              <ul className="mb-3 space-y-1 text-xs text-zinc-400">
                <li>
                  Wallet:{" "}
                  <span className="font-mono text-zinc-200">
                    {walletUsdc !== undefined ? formatUnits(walletUsdc, tokenDecimals) : "—"}
                  </span>{" "}
                  USDC
                </li>
                <li>
                  In engine:{" "}
                  <span className="font-mono text-zinc-200">
                    {collateralWad !== undefined ? formatUnits(collateralWad, 18) : "—"}
                  </span>{" "}
                  (WAD)
                </li>
                {selectedSeriesId !== null ? (
                  <li>
                    Position (#{selectedSeriesId.toString()}):{" "}
                    <span className="font-mono text-zinc-200">
                      {positionQty?.toString() ?? "—"}
                    </span>
                  </li>
                ) : null}
                <li>
                  Allowance:{" "}
                  <span className="font-mono">
                    {allowance !== undefined ? formatUnits(allowance, tokenDecimals) : "—"}
                  </span>
                </li>
              </ul>
            ) : (
              <p className="mb-3 text-xs text-zinc-500">Connect for balances.</p>
            )}
            <button
              type="button"
              className="mb-3 rounded border border-zinc-600 px-3 py-1.5 text-sm hover:bg-zinc-800 disabled:opacity-40"
              disabled={!isConnected || wrongNetwork || !addrsOk || writePending}
              onClick={() => void approveUsdc()}
            >
              Approve USDC (max)
            </button>
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-zinc-500">Deposit USDC</span>
                <input
                  className="w-28 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono"
                  value={depositStr}
                  onChange={(e) => setDepositStr(e.target.value)}
                />
              </label>
              <button
                type="button"
                className="rounded bg-emerald-800 px-3 py-1.5 text-sm hover:bg-emerald-700 disabled:opacity-40"
                disabled={!isConnected || wrongNetwork || !addrsOk || writePending}
                onClick={() => void deposit()}
              >
                Deposit
              </button>
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-zinc-500">Withdraw</span>
                <input
                  className="w-28 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono"
                  value={withdrawStr}
                  onChange={(e) => setWithdrawStr(e.target.value)}
                />
              </label>
              <button
                type="button"
                className="rounded border border-zinc-600 px-3 py-1.5 text-sm hover:bg-zinc-800 disabled:opacity-40"
                disabled={!isConnected || wrongNetwork || !addrsOk || writePending}
                onClick={() => void withdraw()}
              >
                Withdraw
              </button>
            </div>
          </div>
        </section>
      </div>

      <footer className="mt-8 border-t border-zinc-800 pt-3 text-xs text-zinc-600">
        {writePending || txConfirming ? <p>Transaction… {txHash ? String(txHash) : ""}</p> : null}
        {txSuccess ? <p className="text-emerald-500">Confirmed.</p> : null}
      </footer>
    </div>
  );
}
