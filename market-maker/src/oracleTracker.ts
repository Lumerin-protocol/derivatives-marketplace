import type { PublicClient } from "./client.ts";
import type { MakerConfig } from "./config.ts";
import type pino from "pino";
import { HashPowerPerpsDEXAbi as hashPowerPerpsDexAbi } from "../../contracts/abi/HashPowerPerpsDEX.ts";
import { RollingWindow } from "./math.ts";

export class OracleTracker {
  currentPrice = 0n;
  volatility = 0;

  private readonly publicClient: PublicClient;
  private readonly perpsAddress: `0x${string}`;
  private readonly priceWindow: RollingWindow;
  private readonly logger: pino.Logger;

  constructor(publicClient: PublicClient, config: MakerConfig, logger: pino.Logger) {
    this.publicClient = publicClient;
    this.perpsAddress = config.perpsAddress;
    // ~60 samples at poll interval gives a rolling window
    this.priceWindow = new RollingWindow(60);
    this.logger = logger.child({ component: "oracle" });
  }

  async update(): Promise<void> {
    const price = await this.publicClient.readContract({
      address: this.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      functionName: "getMarketPrice",
    });

    this.currentPrice = price;
    this.priceWindow.push(Number(price));
    this.volatility = this.priceWindow.volatility();

    this.logger.debug({ price: price.toString(), volatility: this.volatility }, "oracle tick");
  }
}
