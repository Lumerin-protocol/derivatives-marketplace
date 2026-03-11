import type { PublicClient } from "viem";
import type { MakerConfig } from "./config.ts";
import type pino from "pino";
import { perpsSimpleAbi, multicall3Abi } from "./abi.ts";
import { bigAbs } from "./math.ts";
import { erc20Abi } from "viem";

export class InventoryManager {
  netQuantity = 0n;
  entryPrice = 0n;
  collateralBalance = 0n;
  requiredMargin = 0n;
  ethBalance = 0n;
  tokenBalance = 0n;

  /** Ratio in [-1, 1]: netQuantity / maxPositionSize. */
  inventorySkew = 0;
  availableMargin = 0n;
  utilizationPct = 0;

  private readonly publicClient: PublicClient;
  private readonly config: MakerConfig;
  private readonly mmAddress: `0x${string}`;
  private readonly logger: pino.Logger;
  collateralTokenAddress: `0x${string}` | null = null;

  constructor(
    publicClient: PublicClient,
    config: MakerConfig,
    mmAddress: `0x${string}`,
    logger: pino.Logger,
  ) {
    this.publicClient = publicClient;
    this.config = config;
    this.mmAddress = mmAddress;
    this.logger = logger.child({ component: "inventory" });
  }

  async update(): Promise<void> {
    if (!this.collateralTokenAddress) {
      this.collateralTokenAddress = await this.publicClient.readContract({
        address: this.config.perpsAddress,
        abi: perpsSimpleAbi,
        functionName: "collateralToken",
      });
    }
    const results = await this.publicClient.multicall({
      allowFailure: false,
      contracts: [
        {
          address: this.config.perpsAddress,
          abi: perpsSimpleAbi,
          functionName: "getUserPosition",
          args: [this.mmAddress],
        },
        {
          address: this.config.perpsAddress,
          abi: perpsSimpleAbi,
          functionName: "balanceOf",
          args: [this.mmAddress],
        },
        {
          address: this.collateralTokenAddress,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [this.mmAddress],
        },
        {
          address: this.config.perpsAddress,
          abi: perpsSimpleAbi,
          functionName: "getMaintenanceMargin",
          args: [this.mmAddress],
        },
        {
          address: this.publicClient.chain?.contracts?.multicall3?.address as `0x${string}`,
          abi: multicall3Abi,
          functionName: "getEthBalance",
          args: [this.mmAddress],
        },
      ],
    });
    this.netQuantity = results[0].netQuantity;
    this.entryPrice = results[0].aggregatedEntryPrice;
    this.collateralBalance = results[1];
    this.tokenBalance = results[2];
    this.requiredMargin = results[3];
    this.ethBalance = results[4];

    this.availableMargin =
      this.collateralBalance > this.requiredMargin
        ? this.collateralBalance - this.requiredMargin
        : 0n;

    this.utilizationPct =
      this.collateralBalance > 0n
        ? Number((this.requiredMargin * 100n) / this.collateralBalance)
        : 0;

    const maxPos = this.config.maxPositionSize;
    this.inventorySkew = maxPos > 0n ? Number(this.netQuantity) / Number(maxPos) : 0;
    // Clamp to [-1, 1]
    this.inventorySkew = Math.max(-1, Math.min(1, this.inventorySkew));

    this.logger.debug(
      {
        net: this.netQuantity.toString(),
        balance: this.collateralBalance.toString(),
        skew: this.inventorySkew.toFixed(3),
        utilPct: this.utilizationPct,
      },
      "inventory tick",
    );
  }

  /** Whether the MM has an open position. */
  get hasPosition(): boolean {
    return this.netQuantity !== 0n;
  }

  /** Absolute position size. */
  get absPosition(): bigint {
    return bigAbs(this.netQuantity);
  }
}
