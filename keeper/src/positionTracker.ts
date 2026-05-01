import { zeroAddress, type Address, type WatchContractEventReturnType } from "viem";
import { HashPowerPerpsDEXAbi as hashPowerPerpsDexAbi } from "../../contracts/abi/HashPowerPerpsDEX.ts";
import { CollateralVaultAbi as collateralVaultAbi } from "../../contracts/abi/CollateralVault.ts";
import type { Config } from "./config.ts";
import { computeLiquidationPrice, computeLiquidationState } from "./positionHelper.ts";
import type pino from "pino";
import type { PublicClient } from "./client.ts";

// ── Types ───────────────────────────────────────────────────────────────────

export interface UserState {
  address: Address;
  netQuantity: bigint; // signed: positive = long, negative = short
  entryPrice: bigint; // aggregatedEntryPrice
  collateral: bigint; // receipt token balance (tracked via Transfer events)
  orderMargin: bigint; // price-independent order margin component
  liquidationPrice: bigint;
  isLong: boolean;
}

// ── Position Tracker ────────────────────────────────────────────────────────

export class PositionTracker {
  private users = new Map<Address, UserState>();
  private unwatchFns: WatchContractEventReturnType[] = [];
  private resyncTimer: ReturnType<typeof setInterval> | null = null;

  // Contract parameters (read once, refreshed on resync)
  private maintenanceMarginPercent = 0n;
  private quantityDecimals: bigint = 0n;
  private vaultAddress: Address = zeroAddress;
  private readonly publicClient: PublicClient;
  private readonly config: Config;
  private readonly logger: pino.Logger;

  constructor(pc: PublicClient, cfg: Config, logger: pino.Logger) {
    this.publicClient = pc;
    this.config = cfg;
    this.logger = logger;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await this.readContractParams();
    await this.resync();
    this.startEventWatchers();

    this.resyncTimer = setInterval(() => {
      this.resync().catch((err) => this.logger.error({ err }, "Resync failed"));
    }, this.config.resyncIntervalMs);

    const meta = {
      users: this.users.size,
      maintenanceMarginPercent: this.maintenanceMarginPercent,
    };

    this.logger.info(meta, "Position tracker started");
  }

  stop(): void {
    for (const unwatch of this.unwatchFns) {
      unwatch();
    }
    this.unwatchFns = [];
    if (this.resyncTimer) {
      clearInterval(this.resyncTimer);
      this.resyncTimer = null;
    }
  }

  getUsers(): Map<Address, UserState> {
    return this.users;
  }

  // ── Contract parameter reads ────────────────────────────────────────────

  private async readContractParams(): Promise<void> {
    const [maintenanceMarginPercent, quantityDecimals, vaultAddress] =
      await this.publicClient.multicall({
        contracts: [
          {
            address: this.config.perpsAddress,
            abi: hashPowerPerpsDexAbi,
            functionName: "maintenanceMarginPercent",
          },
          {
            address: this.config.perpsAddress,
            abi: hashPowerPerpsDexAbi,
            functionName: "QUANTITY_DECIMALS",
          },
          {
            address: this.config.perpsAddress,
            abi: hashPowerPerpsDexAbi,
            functionName: "vault",
          },
        ] as const,
        allowFailure: false,
      });
    this.maintenanceMarginPercent = BigInt(maintenanceMarginPercent);
    this.quantityDecimals = BigInt(quantityDecimals);
    this.vaultAddress = vaultAddress;
  }

  // ── Full resync from contract state ─────────────────────────────────────

  async resync(): Promise<void> {
    await this.readContractParams();

    this.logger.info("Resyncing positions from contract…");

    const addresses = (await this.publicClient.readContract({
      address: this.config.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      functionName: "getUsersWithPositions",
    })) as Address[];

    const marketPrice = await this.publicClient.readContract({
      address: this.config.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      functionName: "getMarketPrice",
    });

    this.logger.info({ marketPrice }, "Market price");

    if (addresses.length === 0) {
      this.users.clear();
      this.logger.info("Resync complete — no positions found");
      return;
    }

    // Batch-read state for every user in a single multicall
    const calls = addresses.flatMap((addr) => [
      {
        address: this.config.perpsAddress as Address,
        abi: hashPowerPerpsDexAbi,
        functionName: "getUserPosition" as const,
        args: [addr] as const,
      },
      {
        address: this.config.perpsAddress as Address,
        abi: hashPowerPerpsDexAbi,
        functionName: "balanceOf" as const,
        args: [addr] as const,
      },
      {
        address: this.config.perpsAddress as Address,
        abi: hashPowerPerpsDexAbi,
        functionName: "getMaintenanceMargin" as const,
        args: [addr] as const,
      },
    ]);

    const results = await this.publicClient.multicall({ contracts: calls, allowFailure: false });

    const newUsers = new Map<Address, UserState>();

    for (let i = 0; i < addresses.length; i++) {
      const addr = addresses[i] as Address;
      const position = results[i * 3] as { netQuantity: bigint; aggregatedEntryPrice: bigint };
      const collateral = results[i * 3 + 1] as bigint;
      const maintenanceMargin = results[i * 3 + 2] as bigint;

      if (position.netQuantity === 0n) continue;

      const { orderMargin, liquidationPrice } = computeLiquidationState(
        position.netQuantity,
        position.aggregatedEntryPrice,
        collateral,
        maintenanceMargin,
        marketPrice,
        this.maintenanceMarginPercent,
        this.quantityDecimals,
      );

      newUsers.set(addr, {
        address: addr,
        netQuantity: position.netQuantity,
        entryPrice: position.aggregatedEntryPrice,
        collateral,
        orderMargin,
        liquidationPrice,
        isLong: position.netQuantity > 0n,
      });
    }

    this.users = newUsers;
    this.logger.info({ trackedUsers: this.users.size }, "Resync complete");
  }

  // ── Event watchers ──────────────────────────────────────────────────────

  private startEventWatchers(): void {
    const unwatchPerps = this.publicClient.watchContractEvent({
      address: this.config.perpsAddress,
      abi: hashPowerPerpsDexAbi,
      onLogs: async (logs) => {
        for (const log of logs) {
          this.logger.info({ log }, "Event received");
          //TODO: I think here could be a race, since onLogs is sync function, so if
          //internals are async, there might be a race
          switch (log.eventName) {
            case "OrderMatched": {
              const { maker, taker } = log.args;
              if (maker && taker) {
                await this.onOrderMatched(maker, taker);
              }
              break;
            }
            case "PositionLiquidated": {
              if (log.args.user) {
                this.onPositionLiquidated(log.args.user);
              }
              break;
            }
            case "OrderCreated":
            case "OrderCancelled":
            case "OrderUpdated": {
              if (log.args.participant) {
                await this.onOrderEvent(log.args.participant);
              }
              break;
            }
            default:
              this.logger.debug({ log }, "Unknown event");
              break;
          }
        }
      },
      onError: (error) => this.logger.error({ err: error }, "Perps event watcher error"),
    });

    // Collateral lives on the vault: mints, burns, and product-driven internal transfers
    // all surface as standard ERC-20 Transfer events from the vault contract.
    const unwatchVault = this.publicClient.watchContractEvent({
      address: this.vaultAddress,
      abi: collateralVaultAbi,
      eventName: "Transfer",
      onLogs: (logs) => {
        for (const log of logs) {
          const { from, to, value } = log.args;
          if (from && to && value !== undefined) {
            this.onTransfer(from, to, value);
          }
        }
      },
      onError: (error) => this.logger.error({ err: error }, "Vault event watcher error"),
    });

    this.unwatchFns.push(unwatchPerps, unwatchVault);
    this.logger.info({ vault: this.vaultAddress }, "Event watchers started");
  }

  // ── Event handlers ──────────────────────────────────────────────────────

  private onTransfer(from: Address, to: Address, value: bigint): void {
    const fromUser = this.users.get(from);
    if (fromUser) {
      fromUser.collateral -= value;
      this.recomputeLiquidationPrice(fromUser);
      this.logger.debug(
        {
          user: from,
          delta: -value,
          balance: fromUser.collateral,
          liqPrice: fromUser.liquidationPrice,
        },
        "Balance decreased",
      );
    }

    const toUser = this.users.get(to);
    if (toUser) {
      toUser.collateral += value;
      this.recomputeLiquidationPrice(toUser);
      this.logger.debug(
        { user: to, delta: value, balance: toUser.collateral, liqPrice: toUser.liquidationPrice },
        "Balance increased",
      );
    }
  }

  private async onOrderMatched(maker: Address, taker: Address): Promise<void> {
    await this.syncUser(maker).catch((err) =>
      this.logger.error({ err, user: maker }, "Failed to sync maker after OrderMatched"),
    );
    await this.syncUser(taker).catch((err) =>
      this.logger.error({ err, user: taker }, "Failed to sync taker after OrderMatched"),
    );
  }

  private onPositionLiquidated(user: Address): void {
    this.users.delete(user);
    this.logger.info({ user }, "Position liquidated (removed from tracker)");
  }

  private async onOrderEvent(user: Address): Promise<void> {
    // Order margin changed — lightweight multicall (2 reads)
    await this.recomputeFromContract(user).catch((err) =>
      this.logger.error({ err, user }, "Failed to recompute from contract"),
    );
  }

  // ── Async helpers ─────────────────────────────────────────────────────

  async syncUser(user: Address): Promise<void> {
    const results = await this.publicClient.multicall({
      contracts: [
        {
          address: this.config.perpsAddress,
          abi: hashPowerPerpsDexAbi,
          functionName: "getUserPosition",
          args: [user],
        },
        {
          address: this.config.perpsAddress,
          abi: hashPowerPerpsDexAbi,
          functionName: "balanceOf",
          args: [user],
        },
        {
          address: this.config.perpsAddress,
          abi: hashPowerPerpsDexAbi,
          functionName: "getMaintenanceMargin",
          args: [user],
        },
        {
          address: this.config.perpsAddress,
          abi: hashPowerPerpsDexAbi,
          functionName: "getMarketPrice",
        },
      ],
      allowFailure: false,
    });

    const [position, balance, maintenanceMargin, marketPrice] = results;

    if (position.netQuantity === 0n) {
      this.users.delete(user);
      this.logger.info({ user }, "User synced — no position, removed from tracker");
      return;
    }

    const { orderMargin, liquidationPrice } = computeLiquidationState(
      position.netQuantity,
      position.aggregatedEntryPrice,
      balance,
      maintenanceMargin,
      marketPrice,
      this.maintenanceMarginPercent,
      this.quantityDecimals,
    );

    this.users.set(user, {
      address: user,
      netQuantity: position.netQuantity,
      entryPrice: position.aggregatedEntryPrice,
      collateral: balance,
      orderMargin,
      liquidationPrice,
      isLong: position.netQuantity > 0n,
    });

    this.logger.info(
      { user, netQuantity: position.netQuantity, collateral: balance, liquidationPrice },
      "User synced — position updated",
    );
  }

  private async recomputeFromContract(user: Address): Promise<void> {
    const existing = this.users.get(user);
    if (!existing) return;

    const [maintenanceMargin, marketPrice] = await this.publicClient.multicall({
      contracts: [
        {
          address: this.config.perpsAddress,
          abi: hashPowerPerpsDexAbi,
          functionName: "getMaintenanceMargin",
          args: [user],
        },
        {
          address: this.config.perpsAddress,
          abi: hashPowerPerpsDexAbi,
          functionName: "getMarketPrice",
        },
      ],
      allowFailure: false,
    });

    const { orderMargin, liquidationPrice } = computeLiquidationState(
      existing.netQuantity,
      existing.entryPrice,
      existing.collateral,
      maintenanceMargin,
      marketPrice,
      this.maintenanceMarginPercent,
      this.quantityDecimals,
    );

    existing.orderMargin = orderMargin;
    existing.liquidationPrice = liquidationPrice;

    this.logger.debug(
      { user, orderMargin, liqPrice: liquidationPrice },
      "Recomputed from contract",
    );
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private recomputeLiquidationPrice(user: UserState): void {
    user.liquidationPrice = computeLiquidationPrice(
      user.netQuantity,
      user.entryPrice,
      user.collateral,
      user.orderMargin,
      this.maintenanceMarginPercent,
      this.quantityDecimals,
    );
  }
}
