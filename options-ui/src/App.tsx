import { useCallback, useEffect, useMemo, useState } from "react";
import { type Address, formatUnits, isAddress, maxUint256, parseUnits } from "viem";
import { hardhat } from "wagmi/chains";
import {
  useAccount,
  useChainId,
  useConnect,
  useDisconnect,
  useReadContract,
  useReadContracts,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { injected } from "wagmi/connectors";
import {
  collateralVaultAbi,
  erc20Abi,
  optionMarginEngineAbi,
  optionMatchingRouterAbi,
  registryAbi,
} from "./abis.ts";

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-zinc-400">{label}</span>
      <input
        className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-xs text-zinc-100"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
    </label>
  );
}

export function App() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connect, isPending: connectPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switchPending } = useSwitchChain();

  const registryAddr = import.meta.env.OPTION_REGISTRY_ADDRESS;
  const engineAddr = import.meta.env.OPTION_MARGIN_ENGINE_ADDRESS;
  const routerAddr = import.meta.env.OPTION_MATCHING_ROUTER_ADDRESS;
  const vaultAddr = import.meta.env.VAULT_ADDRESS;
  const usdcAddr = import.meta.env.COLLATERAL_TOKEN_ADDRESS;
  const seriesId = import.meta.env.DEFAULT_OPTIONS_SERIES_ID;

  const addrsOk =
    isAddress(registryAddr) &&
    isAddress(engineAddr) &&
    isAddress(routerAddr) &&
    isAddress(vaultAddr) &&
    isAddress(usdcAddr);

  const { data: nextSeriesId } = useReadContract({
    address: registryAddr,
    abi: registryAbi,
    functionName: "nextSeriesId",
    query: { enabled: addrsOk },
  });

  const { data: seriesData } = useReadContract({
    address: registryAddr,
    abi: registryAbi,
    functionName: "getSeries",
    args: [seriesId],
    query: { enabled: addrsOk },
  });

  const { data: tokenFromEngine } = useReadContract({
    address: engineAddr,
    abi: optionMarginEngineAbi,
    functionName: "collateralToken",
    query: { enabled: addrsOk && isAddress(engineAddr) },
  });

  const usdcEffective = tokenFromEngine && isAddress(tokenFromEngine) ? tokenFromEngine : usdcAddr;

  const { data: decimals } = useReadContract({
    address: usdcEffective,
    abi: erc20Abi,
    functionName: "decimals",
    query: { enabled: addrsOk && isAddress(usdcEffective) },
  });

  const tokenDecimals = decimals ?? 6;

  const { data: liveReads, refetch: refetchLive } = useReadContracts({
    contracts:
      address && addrsOk
        ? [
            {
              address: usdcEffective,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [address],
            },
            {
              address: vaultAddr,
              abi: collateralVaultAbi,
              functionName: "getBalance",
              args: [address],
            },
            {
              address: engineAddr,
              abi: optionMarginEngineAbi,
              functionName: "getCollateral",
              args: [address],
            },
            {
              address: engineAddr,
              abi: optionMarginEngineAbi,
              functionName: "computeAccountIM",
              args: [address],
            },
            {
              address: engineAddr,
              abi: optionMarginEngineAbi,
              functionName: "getReservedMargin",
              args: [address],
            },
            {
              address: engineAddr,
              abi: optionMarginEngineAbi,
              functionName: "getPosition",
              args: [address, seriesId],
            },
          ]
        : [],
    query: {
      enabled: Boolean(address) && addrsOk,
      refetchInterval: 4000,
    },
  });

  const [walletBalR, vaultBalR, collateralWadR, imWadR, reservedWadR, positionR] = liveReads ?? [];

  const walletUsdc = walletBalR?.status === "success" ? walletBalR.result : undefined;
  const vaultBal = vaultBalR?.status === "success" ? vaultBalR.result : undefined;
  const collateralWad = collateralWadR?.status === "success" ? collateralWadR.result : undefined;
  const imWad = imWadR?.status === "success" ? imWadR.result : undefined;
  const reservedWad = reservedWadR?.status === "success" ? reservedWadR.result : undefined;
  const positionQty = positionR?.status === "success" ? positionR.result : undefined;

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: usdcEffective,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, vaultAddr] : undefined,
    query: { enabled: Boolean(address) && addrsOk && isAddress(usdcEffective) },
  });

  const [depositStr, setDepositStr] = useState("1000");
  const [withdrawStr, setWithdrawStr] = useState("100");
  const [priceTicksStr, setPriceTicksStr] = useState("100");
  const [sizeStr, setSizeStr] = useState("1000000");
  const [orderSideBuy, setOrderSideBuy] = useState(true);
  const [postOnly, setPostOnly] = useState(false);

  const {
    writeContract,
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
  }, [refetchLive, refetchAllowance]);

  useEffect(() => {
    if (txSuccess) bumpQueries();
  }, [txSuccess, bumpQueries]);

  const approveUsdc = () => {
    if (!address || !isAddress(usdcEffective)) return;
    writeContract({
      address: usdcEffective,
      abi: erc20Abi,
      functionName: "approve",
      args: [vaultAddr, maxUint256],
    });
  };

  const deposit = () => {
    if (!address) return;
    const amt = parseUnits(depositStr || "0", tokenDecimals);
    if (amt === 0n) return;
    writeContract({
      address: engineAddr,
      abi: optionMarginEngineAbi,
      functionName: "deposit",
      args: [amt],
    });
  };

  const withdraw = () => {
    if (!address) return;
    const amt = parseUnits(withdrawStr || "0", tokenDecimals);
    if (amt === 0n) return;
    writeContract({
      address: engineAddr,
      abi: optionMarginEngineAbi,
      functionName: "withdraw",
      args: [amt],
    });
  };

  const submitOrder = () => {
    const priceTicks = BigInt(priceTicksStr || "0");
    const size = BigInt(sizeStr || "0");
    if (priceTicks === 0n || size === 0n) return;
    writeContract({
      address: routerAddr,
      abi: optionMatchingRouterAbi,
      functionName: "submitOrder",
      args: [
        {
          seriesId: seriesId,
          isBuy: orderSideBuy,
          priceTicks,
          size,
          orderType: 0,
          postOnly,
          reduceOnly: false,
        },
      ],
    });
  };

  const series = seriesData;
  const strikeE8 = series?.[0];
  const expiryTs = series?.[1];
  const isCall = series?.[2];
  const tickSizeE8 = series?.[3];
  const lotSize = series?.[4];
  const status = series?.[5];

  const premiumFromTicks = useMemo(() => {
    if (tickSizeE8 === undefined || priceTicksStr === "") return null;
    try {
      const ticks = BigInt(priceTicksStr);
      return (ticks * BigInt(tickSizeE8)) / 10n ** 8n;
    } catch {
      return null;
    }
  }, [tickSizeE8, priceTicksStr]);

  const statusLabel = ["Inactive", "Active", "Frozen", "Settled"][status ?? 0] ?? "?";

  return (
    <div className="mx-auto max-w-3xl p-6">
      <header className="mb-8 border-b border-zinc-800 pb-6">
        <h1 className="text-xl font-semibold tracking-tight text-white">Options lab (Hardhat)</h1>
        <p className="mt-2 text-sm text-zinc-500">
          RPC{" "}
          <span className="font-mono text-zinc-300">
            {import.meta.env.ETH_NODE_ADDRESS.toString()}
          </span>{" "}
          (chain ID <span className="font-mono text-zinc-300">31337</span>). Defaults come from
          repo-root <span className="font-mono text-zinc-300">.env.local</span> via{" "}
          <span className="font-mono text-zinc-300">pnpm deploy-local</span>.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {!isConnected ? (
            <button
              type="button"
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              disabled={connectPending}
              onClick={() => connect({ connector: injected() })}
            >
              {connectPending ? "Connecting…" : "Connect"}
            </button>
          ) : (
            <>
              <span className="font-mono text-xs text-zinc-400">{address}</span>
              <button
                type="button"
                className="rounded-lg border border-zinc-600 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                onClick={() => disconnect()}
              >
                Disconnect
              </button>
            </>
          )}
          {chainId !== hardhat.id ? (
            <button
              type="button"
              className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500 disabled:opacity-50"
              disabled={switchPending}
              onClick={() => switchChain({ chainId: hardhat.id })}
            >
              Switch to Hardhat (31337)
            </button>
          ) : (
            <span className="rounded bg-zinc-800 px-2 py-1 text-xs text-emerald-400">Hardhat</span>
          )}
        </div>
      </header>

      <section className="mb-8 rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-500">
          Contract addresses
        </h2>

        {!addrsOk ? (
          <p className="mt-3 text-sm text-amber-400">
            Enter valid 0x addresses to load chain data.
          </p>
        ) : null}
      </section>

      <section className="mb-8 grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <h2 className="mb-2 text-sm font-medium text-zinc-300">Registry</h2>
          <p className="text-xs text-zinc-500">
            nextSeriesId:{" "}
            <span className="font-mono text-zinc-300">{nextSeriesId?.toString() ?? "—"}</span>
          </p>
          {series ? (
            <ul className="mt-3 space-y-1 text-xs text-zinc-400">
              <li>
                Series <span className="font-mono text-zinc-200">{String(seriesId)}</span> —{" "}
                <span className="text-zinc-200">{statusLabel}</span>
              </li>
              <li>Strike (1e8): {strikeE8?.toString()}</li>
              <li>Expiry: {expiryTs?.toString()}</li>
              <li>{isCall ? "Call" : "Put"}</li>
              <li>tickSizeE8: {tickSizeE8?.toString()}</li>
              <li>lotSize (raw units): {lotSize?.toString()}</li>
            </ul>
          ) : addrsOk ? (
            <p className="mt-2 text-xs text-zinc-500">Loading series…</p>
          ) : null}
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <h2 className="mb-2 text-sm font-medium text-zinc-300">Your balances</h2>
          {!isConnected ? (
            <p className="text-xs text-zinc-500">Connect a wallet.</p>
          ) : (
            <ul className="space-y-1 text-xs text-zinc-400">
              <li>
                Wallet USDC:{" "}
                <span className="font-mono text-zinc-200">
                  {walletUsdc !== undefined ? formatUnits(walletUsdc, tokenDecimals) : "—"}
                </span>
              </li>
              <li>
                Vault (collateral):{" "}
                <span className="font-mono text-zinc-200">
                  {vaultBal !== undefined ? formatUnits(vaultBal, tokenDecimals) : "—"}
                </span>
              </li>
              <li>
                Engine reported (WAD):{" "}
                <span className="font-mono text-zinc-200">
                  {collateralWad !== undefined ? formatUnits(collateralWad, 18) : "—"}
                </span>
              </li>
              <li>
                Account IM (WAD):{" "}
                <span className="font-mono text-zinc-200">
                  {imWad !== undefined ? formatUnits(imWad, 18) : "—"}
                </span>
              </li>
              <li>
                Reserved margin (WAD):{" "}
                <span className="font-mono text-zinc-200">
                  {reservedWad !== undefined ? formatUnits(reservedWad, 18) : "—"}
                </span>
              </li>
              <li>
                Position series {String(seriesId)} (raw qty):{" "}
                <span className="font-mono text-zinc-200">{positionQty?.toString() ?? "—"}</span>
              </li>
            </ul>
          )}
          <button
            type="button"
            className="mt-3 text-xs text-emerald-500 hover:underline"
            onClick={() => bumpQueries()}
          >
            Refresh
          </button>
        </div>
      </section>

      <section className="mb-8 rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <h2 className="mb-3 text-sm font-medium text-zinc-300">Collateral</h2>
        <p className="mb-3 text-xs text-zinc-500">
          Approve USDC for the vault, then deposit into OptionMarginEngine. Allowance:{" "}
          <span className="font-mono">
            {allowance !== undefined ? formatUnits(allowance, tokenDecimals) : "—"}
          </span>
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-lg border border-zinc-600 px-3 py-2 text-sm hover:bg-zinc-800 disabled:opacity-40"
            disabled={!isConnected || !addrsOk || writePending}
            onClick={() => approveUsdc()}
          >
            Approve USDC → vault (max)
          </button>
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-zinc-500">Deposit (USDC)</span>
            <input
              className="w-32 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono"
              value={depositStr}
              onChange={(e) => setDepositStr(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="rounded-lg bg-emerald-700 px-3 py-2 text-sm hover:bg-emerald-600 disabled:opacity-40"
            disabled={!isConnected || !addrsOk || writePending}
            onClick={() => deposit()}
          >
            Deposit
          </button>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-zinc-500">Withdraw (USDC)</span>
            <input
              className="w-32 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono"
              value={withdrawStr}
              onChange={(e) => setWithdrawStr(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="rounded-lg border border-zinc-600 px-3 py-2 text-sm hover:bg-zinc-800 disabled:opacity-40"
            disabled={!isConnected || !addrsOk || writePending}
            onClick={() => withdraw()}
          >
            Withdraw
          </button>
        </div>
      </section>

      <section className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <h2 className="mb-3 text-sm font-medium text-zinc-300">
          Router — LIMIT order (series {String(seriesId)})
        </h2>
        <p className="mb-3 text-xs text-zinc-500">
          Size must be a multiple of lotSize. Approx premium (1e8 notional):{" "}
          <span className="font-mono text-zinc-300">
            {premiumFromTicks !== null ? `${premiumFromTicks.toString()} (÷1e8 USD)` : "—"}
          </span>
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={orderSideBuy}
              onChange={(e) => setOrderSideBuy(e.target.checked)}
            />
            Buy
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={postOnly}
              onChange={(e) => setPostOnly(e.target.checked)}
            />
            Post-only
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-zinc-500">priceTicks</span>
            <input
              className="w-36 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono"
              value={priceTicksStr}
              onChange={(e) => setPriceTicksStr(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-zinc-500">size (raw)</span>
            <input
              className="w-40 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono"
              value={sizeStr}
              onChange={(e) => setSizeStr(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="rounded-lg bg-sky-700 px-4 py-2 text-sm hover:bg-sky-600 disabled:opacity-40"
            disabled={!isConnected || !addrsOk || writePending}
            onClick={() => submitOrder()}
          >
            submitOrder
          </button>
        </div>
      </section>

      <footer className="mt-8 border-t border-zinc-800 pt-4 text-xs text-zinc-600">
        {writePending || txConfirming ? (
          <p>Sending transaction… {txHash ? String(txHash) : ""}</p>
        ) : null}
        {txSuccess ? <p className="text-emerald-500">Transaction confirmed.</p> : null}
        {writeError ? (
          <p className="mt-2 max-h-32 overflow-auto text-red-400">{writeError.message}</p>
        ) : null}
      </footer>
    </div>
  );
}
