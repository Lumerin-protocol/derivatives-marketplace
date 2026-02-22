import { type PublicClient, type WalletClient, type Account, BaseError } from "viem";
import { perpsSimpleAbi, aggregatorV3InterfaceAbi } from "./abi.ts";
import type { Config } from "./config.ts";
import type { PositionTracker, UserState } from "./positionTracker.ts";
import type pino from "pino";

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
          abi: perpsSimpleAbi as any,
          functionName: "liquidationFee",
        },
        { address: this.config.perpsAddress, abi: perpsSimpleAbi as any, functionName: "decimals" },
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
        abi: perpsSimpleAbi,
        functionName: "getMarketPrice",
      });

      this.logger.debug({ currentPrice }, "Current price");

      this._lastPrice = currentPrice;
      this._lastCheckAt = new Date();

      const candidates = this.findCandidates(currentPrice);

      if (candidates.length > 0) {
        this.logger.info(
          {
            count: candidates.length,
            price: currentPrice,
            users: candidates.map((u) => u.address),
          },
          "Liquidation candidates found",
        );

        // Process sequentially to avoid nonce issues
        for (const candidate of candidates) {
          await this.attemptLiquidation(candidate, currentPrice);
        }
      } else {
        this.logger.debug("No liquidation candidates found");
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

  // ── Liquidation execution ───────────────────────────────────────────────

  private async attemptLiquidation(user: UserState, currentPrice: bigint): Promise<void> {
    const logCtx = {
      user: user.address,
      currentPrice,
      liquidationPrice: user.liquidationPrice,
      netQuantity: user.netQuantity,
      collateral: user.collateral,
      isLong: user.isLong,
    };

    try {
      // On-chain safety check — simulate the liquidate() call
      const { request } = await this.publicClient.simulateContract({
        address: this.config.perpsAddress,
        abi: perpsSimpleAbi,
        functionName: "liquidate",
        args: [user.address],
        account: this.account,
      });

      // Estimate gas and fetch ETH price for profitability check
      const [gasEstimate, gasPrice, ethPrice] = await Promise.all([
        this.publicClient.estimateContractGas({
          address: this.config.perpsAddress,
          abi: perpsSimpleAbi,
          functionName: "liquidate",
          args: [user.address],
          account: this.account,
        }),
        this.publicClient.getGasPrice(),
        this.getEthPrice(),
      ]);

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
        return;
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
        return;
      }

      // Execute
      const txHash = await this.walletClient.writeContract(request);

      this.logger.info(
        {
          ...logCtx,
          txHash,
          liquidationFee: this.liquidationFee,
          gasCostCollateral,
          netProfit,
        },
        "Liquidation tx submitted",
      );

      this._liquidationsExecuted++;

      // Wait for confirmation
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
      const errorStr = String(error);

      if (errorStr.includes("NotLiquidatable")) {
        this.logger.warn(logCtx, "Simulation reverted: NotLiquidatable (state drift)");
      } else {
        this.logger.error({ logCtx }, "Liquidation attempt failed");
      }
    }
  }
}
