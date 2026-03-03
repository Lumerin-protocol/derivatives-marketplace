import type { PublicClient } from "viem";
import type { MakerConfig } from "./config.ts";
import type pino from "pino";
import { perpsSimpleAbi, aggregatorV3InterfaceAbi } from "./abi.ts";
import { RollingWindow } from "./math.ts";

export class GasTracker {
  currentGasPrice = 0n;
  medianGasPrice = 0;
  gasSpikePct = 0;
  isGasSpiking = false;

  /** Estimated gas units for a single createOrder call. */
  estimatedCreateGas = 300_000n;
  /** Estimated gas units for a single cancelOrder call. */
  estimatedCancelGas = 100_000n;

  /** Current ETH price in collateral decimals (e.g. USDC 6 decimals). */
  ethPriceUsd = 0n;

  private readonly publicClient: PublicClient;
  private readonly config: MakerConfig;
  private readonly gasWindow: RollingWindow;
  private readonly logger: pino.Logger;
  private gasEstimatesCached = false;

  constructor(publicClient: PublicClient, config: MakerConfig, logger: pino.Logger) {
    this.publicClient = publicClient;
    this.config = config;
    this.gasWindow = new RollingWindow(60);
    this.logger = logger.child({ component: "gas" });
  }

  /**
   * One-time: estimate gas for createOrder / cancelOrder.
   * Falls back to defaults if estimation fails (e.g. no orders to cancel).
   */
  async calibrate(mmAddress: `0x${string}`): Promise<void> {
    if (this.gasEstimatesCached) return;

    try {
      const createGas = await this.publicClient.estimateContractGas({
        address: this.config.perpsAddress,
        abi: perpsSimpleAbi,
        functionName: "createOrder",
        args: [1_000_000n, 1_000_000n],
        account: mmAddress,
      });
      this.estimatedCreateGas = createGas;
      this.logger.info({ createGas: createGas.toString() }, "calibrated createOrder gas");
    } catch {
      this.logger.warn("createOrder gas estimation failed, using default");
    }

    this.gasEstimatesCached = true;
  }

  async update(): Promise<void> {
    this.currentGasPrice = await this.publicClient.getGasPrice();
    const gasPriceNum = Number(this.currentGasPrice);
    this.gasWindow.push(gasPriceNum);
    this.medianGasPrice = this.gasWindow.median();

    if (this.medianGasPrice > 0) {
      this.gasSpikePct = ((gasPriceNum - this.medianGasPrice) / this.medianGasPrice) * 100;
    } else {
      this.gasSpikePct = 0;
    }

    this.isGasSpiking = this.gasSpikePct > this.config.gasSpikeThresholdPct;

    if (this.config.ethPriceFeedAddress) {
      await this.updateEthPrice();
    }

    this.logger.debug(
      { gasGwei: gasPriceNum / 1e9, spikePct: this.gasSpikePct, spiking: this.isGasSpiking },
      "gas tick",
    );
  }

  private async updateEthPrice(): Promise<void> {
    try {
      const [, answer, , ,] = await this.publicClient.readContract({
        address: this.config.ethPriceFeedAddress!,
        abi: aggregatorV3InterfaceAbi,
        functionName: "latestRoundData",
      });

      const decimals = await this.publicClient.readContract({
        address: this.config.ethPriceFeedAddress!,
        abi: aggregatorV3InterfaceAbi,
        functionName: "decimals",
      });

      // Scale ETH price to 6-decimal USDC terms
      if (answer > 0n) {
        this.ethPriceUsd = decimals >= 6
          ? answer / 10n ** BigInt(decimals - 6)
          : answer * 10n ** BigInt(6 - decimals);
      }
    } catch {
      this.logger.warn("ETH price feed read failed");
    }
  }

  /** Cost of a single createOrder in collateral (USDC) units. */
  get placeCostUsd(): bigint {
    return this.gasCostUsd(this.estimatedCreateGas);
  }

  /** Cost of a single cancelOrder in collateral (USDC) units. */
  get cancelCostUsd(): bigint {
    return this.gasCostUsd(this.estimatedCancelGas);
  }

  /** Cost of one cancel + one place (a single order round-trip). */
  get roundTripCostUsd(): bigint {
    return this.cancelCostUsd + this.placeCostUsd;
  }

  /** Full requote cycle: N cancels + N places, where N = levels per side * 2. */
  requoteCycleCostUsd(totalOrders: number): bigint {
    return BigInt(totalOrders) * this.roundTripCostUsd;
  }

  /** Compute the maxFeePerGas to use, capped relative to median but never below current gas price. */
  cappedGasPrice(): bigint {
    const medianBig = BigInt(Math.round(this.medianGasPrice));
    if (medianBig === 0n) return this.currentGasPrice;
    const cap = medianBig * BigInt(Math.round(this.config.gasCapMultiplier * 100)) / 100n;
    // Never go below current gas price — a cap below base fee causes tx failure
    return this.currentGasPrice < cap ? cap : this.currentGasPrice;
  }

  private gasCostUsd(gasUnits: bigint): bigint {
    if (this.ethPriceUsd === 0n) return 0n;
    // gasCost_eth = gasUnits * gasPrice (in wei) → divide by 1e18 for ETH
    // gasCost_usd = gasCost_eth * ethPriceUsd (6 decimals)
    // Combined: gasUnits * gasPrice * ethPriceUsd / 1e18
    return (gasUnits * this.currentGasPrice * this.ethPriceUsd) / 10n ** 18n;
  }
}
