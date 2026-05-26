import type { PublicClient, WalletClient, Account } from "./client.ts";
import { HashPowerPerpsDEXAbi as hashPowerPerpsDexAbi } from "../../contracts/abi/HashPowerPerpsDEX.ts";
import { AggregatorV3InterfaceAbi as aggregatorV3InterfaceAbi } from "../../contracts/abi/AggregatorV3Interface.ts";
import type { Config } from "./config.ts";
import type { PositionTracker, UserState } from "./positionTracker.ts";
import type pino from "pino";
import { encodeFunctionData, type Address, type Hex } from "viem";

/**
 * Per-user gas overhead for the two extra delegatecall frames added by the
 * `multicallStopOnFailure(multicallStopOnFailure(liquidatePosition))` nesting.
 * Used as a floor when sizing the batch tx gas — see {@link buildBatchGasLimit}.
 */
const NESTED_MULTICALL_OVERHEAD_PER_USER = 50_000n;

/**
 * Encode a `liquidatePosition` sub-call wrapped in a single-entry inner
 * `multicallStopOnFailure`. The inner converts a per-user revert
 * (`NotLiquidatable`, `OrdersStillOpen`, etc.) into a successful return,
 * so the caller's outer multicall can skip and continue to the next user.
 *
 * Composition: `outer = multicallStopOnFailure([encodeInnerLiquidatePosition(u_i) for u_i in users])`.
 */
function encodeInnerLiquidatePosition(user: Address): Hex {
  return encodeFunctionData({
    abi: hashPowerPerpsDexAbi,
    functionName: "multicallStopOnFailure",
    args: [
      [
        encodeFunctionData({
          abi: hashPowerPerpsDexAbi,
          functionName: "liquidatePosition",
          args: [user],
        }),
      ],
    ],
  });
}

/**
 * Sum per-user `liquidatePosition` gas estimates plus a fixed per-user
 * overhead for the nested-multicall framing, then apply a 20% safety buffer.
 *
 * `eth_estimateGas` over the outer multicall can silently under-estimate
 * (an OOG inside an inner multicall reverts the inner with a non-empty
 * selector, which the outer treats as a normal stop instead of as gas
 * starvation), so we don't trust it on its own — we use this floor.
 */
function buildBatchGasLimit(perUserEstimates: readonly bigint[]): bigint {
  const sum = perUserEstimates.reduce((acc, g) => acc + g, 0n);
  const overhead = NESTED_MULTICALL_OVERHEAD_PER_USER * BigInt(perUserEstimates.length);
  return ((sum + overhead) * 12n) / 10n;
}

interface ValidatedCandidate {
  user: UserState;
  /** Gas estimate for the unwrapped per-user `liquidatePosition` call. */
  gasEstimate: bigint;
}

export class Liquidator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private liquidationFee = 0n;
  private collateralDecimals = 0;
  private ethFeedDecimals = 0;
  private _lastPrice = 0n;
  private _lastCheckAt: Date | null = null;
  private _liquidationsExecuted = 0;
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly account: Account;
  private readonly tracker: PositionTracker;
  private readonly config: Config;
  private readonly logger: pino.Logger;

  constructor(
    pc: PublicClient,
    wc: WalletClient,
    acc: Account,
    tracker: PositionTracker,
    cfg: Config,
    logger: pino.Logger,
  ) {
    this.publicClient = pc;
    this.walletClient = wc;
    this.account = acc;
    this.tracker = tracker;
    this.config = cfg;
    this.logger = logger;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async start(): Promise<void> {
    // Read static contract params in a single multicall
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = (await this.publicClient.multicall({
      contracts: [
        {
          address: this.config.perpsAddress,
          abi: hashPowerPerpsDexAbi as any,
          functionName: "liquidationFee",
        },
        {
          address: this.config.perpsAddress,
          abi: hashPowerPerpsDexAbi as any,
          functionName: "decimals",
        },
        ...(this.config.ethPriceFeedAddress
          ? [
              {
                address: this.config.ethPriceFeedAddress,
                abi: aggregatorV3InterfaceAbi as any,
                functionName: "decimals",
              },
            ]
          : []),
      ],
      allowFailure: false,
    })) as [bigint, number, number | undefined];

    this.liquidationFee = results[0] as bigint;
    this.collateralDecimals = Number(results[1]);
    this.ethFeedDecimals = results[2] != null ? Number(results[2]) : 0;

    // Run first check immediately, then at interval
    this.checkPrice();
    this.timer = setInterval(() => this.checkPrice(), this.config.pollIntervalMs);

    this.logger.info(
      {
        pollIntervalMs: this.config.pollIntervalMs,
        dryRun: this.config.dryRun,
        liquidationFee: this.liquidationFee,
        collateralDecimals: this.collateralDecimals,
        ethFeedDecimals: this.ethFeedDecimals,
      },
      "Liquidator started",
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get stats() {
    return {
      lastPrice: this._lastPrice,
      lastCheckAt: this._lastCheckAt,
      liquidationsExecuted: this._liquidationsExecuted,
    };
  }

  // ── ETH price ─────────────────────────────────────────────────────────

  /** Fetch latest ETH/USD price from Chainlink feed, returns raw answer. */
  private async getEthPrice(): Promise<bigint> {
    if (!this.config.ethPriceFeedAddress) {
      return 0n;
    }
    const [, answer] = (await this.publicClient.readContract({
      address: this.config.ethPriceFeedAddress,
      abi: aggregatorV3InterfaceAbi,
      functionName: "latestRoundData",
    })) as [bigint, bigint, bigint, bigint, bigint];

    return answer;
  }

  /**
   * Convert gas cost in wei to collateral token units using the ETH/USD feed.
   *
   *   gasCostCollateral = gasCostWei * ethPrice / 10^(18 + ethFeedDecimals − collateralDecimals)
   */
  private gasCostToCollateral(gasCostWei: bigint, ethPrice: bigint): bigint {
    if (ethPrice === 0n) return 0n;
    const exponent = 18 + this.ethFeedDecimals - this.collateralDecimals;
    return (gasCostWei * ethPrice) / 10n ** BigInt(exponent);
  }

  // ── Main loop ─────────────────────────────────────────────────────────

  private async checkPrice(): Promise<void> {
    try {
      const currentPrice = await this.publicClient.readContract({
        address: this.config.perpsAddress,
        abi: hashPowerPerpsDexAbi,
        functionName: "getMarketPrice",
      });

      this.logger.debug({ currentPrice }, "Current price");

      this._lastPrice = currentPrice;
      this._lastCheckAt = new Date();

      const candidates = this.findCandidates(currentPrice);

      if (candidates.length === 0) {
        this.logger.debug("No liquidation candidates found");
        return;
      }

      this.logger.info(
        {
          count: candidates.length,
          price: currentPrice,
          users: candidates.map((u) => u.address),
        },
        "Liquidation candidates found",
      );

      const validated = await this.validateCandidates(candidates, currentPrice);
      if (validated.length === 0) return;

      const [first, ...rest] = validated;
      if (first !== undefined && rest.length === 0) {
        await this.executeSingleLiquidation(first, currentPrice);
      } else {
        await this.executeBatchLiquidation(validated, currentPrice);
      }
    } catch (err) {
      this.logger.error({ err }, "Price check failed");
    }
  }

  // ── Candidate detection ─────────────────────────────────────────────────

  private findCandidates(currentPrice: bigint): UserState[] {
    const candidates: UserState[] = [];

    for (const user of this.tracker.getUsers().values()) {
      if (user.liquidationPrice <= 0n) continue;

      const isCandidate = user.isLong
        ? currentPrice <= user.liquidationPrice
        : currentPrice >= user.liquidationPrice;

      if (isCandidate) {
        candidates.push(user);
      }
    }

    return candidates;
  }

  // ── Validation ──────────────────────────────────────────────────────────

  /**
   * Simulate each candidate on-chain, check profitability, return only
   * the ones that are safe to execute.
   */
  private async validateCandidates(
    candidates: UserState[],
    currentPrice: bigint,
  ): Promise<ValidatedCandidate[]> {
    const [gasPrice, ethPrice] = await Promise.all([
      this.publicClient.getGasPrice(),
      this.getEthPrice(),
    ]);

    const validated: ValidatedCandidate[] = [];

    for (const user of candidates) {
      const logCtx = this.logContext(user, currentPrice);

      try {
        await this.publicClient.simulateContract({
          address: this.config.perpsAddress,
          abi: hashPowerPerpsDexAbi,
          functionName: "liquidatePosition",
          args: [user.address],
          account: this.account,
        });

        const gasEstimate = await this.publicClient.estimateContractGas({
          address: this.config.perpsAddress,
          abi: hashPowerPerpsDexAbi,
          functionName: "liquidatePosition",
          args: [user.address],
          account: this.account,
        });

        const gasCostWei = gasEstimate * gasPrice;
        const gasCostCollateral = this.gasCostToCollateral(gasCostWei, ethPrice);
        const netProfit = this.liquidationFee - gasCostCollateral;

        if (netProfit < this.config.minProfitMargin) {
          this.logger.info(
            {
              ...logCtx,
              liquidationFee: this.liquidationFee,
              gasCostCollateral,
              netProfit,
              minProfitMargin: this.config.minProfitMargin,
            },
            "Skipping — below minimum profit margin",
          );
          continue;
        }

        if (this.config.dryRun) {
          this.logger.info(
            {
              ...logCtx,
              gasEstimate,
              gasCostWei,
              gasCostCollateral,
              ethPrice,
              liquidationFee: this.liquidationFee,
              netProfit,
            },
            "DRY RUN — would liquidate",
          );
          continue;
        }

        validated.push({ user, gasEstimate });
      } catch (error) {
        const errorStr = String(error);
        if (errorStr.includes("NotLiquidatable") || errorStr.includes("OrdersStillOpen")) {
          this.logger.warn(
            { ...logCtx, reason: errorStr.includes("OrdersStillOpen") ? "OrdersStillOpen" : "NotLiquidatable" },
            "Simulation reverted (state drift)",
          );
        } else {
          this.logger.error({ logCtx }, "Liquidation validation failed");
        }
      }
    }

    return validated;
  }

  // ── Liquidation execution ───────────────────────────────────────────────

  /**
   * Bundle N validated users into a single tx via nested
   * `multicallStopOnFailure(multicallStopOnFailure(liquidatePosition))`.
   * The inner multicall absorbs per-user reverts (state drift between
   * validation and execution) so the outer one keeps going. Falls back
   * to per-user calls on tx-level failure.
   */
  private async executeBatchLiquidation(
    validated: ValidatedCandidate[],
    currentPrice: bigint,
  ): Promise<void> {
    const addresses = validated.map((v) => v.user.address);
    const innerCalls = addresses.map(encodeInnerLiquidatePosition);
    const gas = buildBatchGasLimit(validated.map((v) => v.gasEstimate));

    try {
      const txHash = await this.walletClient.writeContract({
        address: this.config.perpsAddress,
        abi: hashPowerPerpsDexAbi,
        functionName: "multicallStopOnFailure",
        args: [innerCalls],
        account: this.account,
        gas,
      });

      this.logger.info(
        { count: validated.length, users: addresses, gas, txHash },
        "Batch liquidation tx submitted",
      );
      this._liquidationsExecuted += validated.length;

      const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
      this.logger.info(
        {
          txHash,
          status: receipt.status,
          gasUsed: receipt.gasUsed,
          blockNumber: receipt.blockNumber,
          count: validated.length,
        },
        "Batch liquidation confirmed",
      );

      if (receipt.status === "success") {
        for (const v of validated) {
          await this.tracker.syncUser(v.user.address);
        }
      }
    } catch (error) {
      this.logger.warn(
        { count: validated.length, users: addresses, error },
        "Batch liquidation failed, falling back to individual calls",
      );

      for (const v of validated) {
        await this.executeSingleLiquidation(v, currentPrice);
      }
    }
  }

  private async executeSingleLiquidation(
    validated: ValidatedCandidate,
    currentPrice: bigint,
  ): Promise<void> {
    const { user, gasEstimate } = validated;
    const logCtx = this.logContext(user, currentPrice);

    try {
      const txHash = await this.walletClient.writeContract({
        address: this.config.perpsAddress,
        abi: hashPowerPerpsDexAbi,
        functionName: "liquidatePosition",
        args: [user.address],
        account: this.account,
        gas: (gasEstimate * 12n) / 10n,
      });

      this.logger.info({ ...logCtx, txHash }, "Liquidation tx submitted");
      this._liquidationsExecuted++;

      const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
      this.logger.info(
        {
          user: user.address,
          txHash,
          status: receipt.status,
          gasUsed: receipt.gasUsed,
          blockNumber: receipt.blockNumber,
        },
        "Liquidation confirmed",
      );

      if (receipt.status === "success") {
        await this.tracker.syncUser(user.address);
      }
    } catch (error) {
      this.logger.error({ ...logCtx, error }, "Liquidation attempt failed");
    }
  }

  private logContext(user: UserState, currentPrice: bigint) {
    return {
      user: user.address,
      currentPrice,
      liquidationPrice: user.liquidationPrice,
      netQuantity: user.netQuantity,
      collateral: user.collateral,
      isLong: user.isLong,
    };
  }
}
