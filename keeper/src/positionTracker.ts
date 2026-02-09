import type { Address, PublicClient, WatchContractEventReturnType } from "viem";
import { perpsSimpleAbi } from "./abi.ts";
import type { Config } from "./config.ts";
import { computeLiquidationPrice, computeLiquidationState } from "./positionHelper.ts";
import type pino from "pino";

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

    this.logger.info(
      {
        trackedUsers: this.users.size,
        maintenanceMarginPercent: Number(this.maintenanceMarginPercent),
      },
      "Position tracker started",
    );
  }

  stop(): void {
    for (const unwatch of this.unwatchFns) unwatch();
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
    const [maintenanceMarginPercent, quantityDecimals] = await this.publicClient.multicall({
      contracts: [
        {
          address: this.config.perpsAddress,
          abi: perpsSimpleAbi,
          functionName: "maintenanceMarginPercent",
        },
        {
          address: this.config.perpsAddress,
          abi: perpsSimpleAbi,
          functionName: "QUANTITY_DECIMALS",
        },
      ] as const,
      allowFailure: false,
    });
    this.maintenanceMarginPercent = BigInt(maintenanceMarginPercent);
    this.quantityDecimals = BigInt(quantityDecimals);
  }

  // ── Full resync from contract state ─────────────────────────────────────

  async resync(): Promise<void> {
    this.logger.info("Resyncing positions from contract…");

    const addresses = (await this.publicClient.readContract({
      address: this.config.perpsAddress,
      abi: perpsSimpleAbi,
      functionName: "getUsersWithPositions",
    })) as Address[];

    const marketPrice = await this.publicClient.readContract({
      address: this.config.perpsAddress,
      abi: perpsSimpleAbi,
      functionName: "getMarketPrice",
    });

    this.logger.info({ marketPrice }, "Market price");

    if (addresses.length === 0) {
      this.users.clear();
      this.logger.info("Resync complete — no positions found");
      return;
    }

    await this.readContractParams();

    // Batch-read state for every user in a single multicall
    const calls = addresses.flatMap((addr) => [
      {
        address: this.config.perpsAddress as Address,
        abi: perpsSimpleAbi,
        functionName: "getUserPosition" as const,
        args: [addr] as const,
      },
      {
        address: this.config.perpsAddress as Address,
        abi: perpsSimpleAbi,
        functionName: "balanceOf" as const,
        args: [addr] as const,
      },
      {
        address: this.config.perpsAddress as Address,
        abi: perpsSimpleAbi,
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
    // Transfer — local balance tracking
    this.watch("Transfer", (logs) => {
      for (const log of logs) {
        const { from, to, value } = log.args as { from: Address; to: Address; value: bigint };
        this.onTransfer(from, to, value);
      }
    });

    // PositionTrade — position updates from event args (zero RPC for existing users)
    this.watch("PositionTrade", (logs) => {
      for (const log of logs) {
        const args = log.args as {
          user: Address;
          netQuantityAfter: bigint;
          aggregatedEntryPriceAfter: bigint;
        };
        this.onPositionTrade(args.user, args.netQuantityAfter, args.aggregatedEntryPriceAfter);
      }
    });

    // PositionClosed — detect full closes (no accompanying PositionTrade)
    this.watch("PositionClosed", (logs) => {
      for (const log of logs) {
        const { user } = log.args as { user: Address };
        this.onPositionClosed(user);
      }
    });

    // PositionLiquidated — remove user
    this.watch("PositionLiquidated", (logs) => {
      for (const log of logs) {
        const { user } = log.args as { user: Address };
        this.onPositionLiquidated(user);
      }
    });

    // Order events — order margin changed, need lightweight RPC
    for (const eventName of [
      "OrderCreated",
      "OrderCancelled",
      "OrderFilled",
      "OrderUpdated",
    ] as const) {
      this.watch(eventName, (logs) => {
        for (const log of logs) {
          const { participant } = log.args as { participant: Address };
          if (participant && this.users.has(participant)) {
            this.onOrderEvent(participant);
          }
        }
      });
    }

    this.logger.info("Event watchers started");
  }

  // biome-ignore lint/suspicious/noExplicitAny: viem event log union types are complex
  private watch(eventName: string, onLogs: (logs: any[]) => void): void {
    const unwatch = this.publicClient.watchContractEvent({
      address: this.config.perpsAddress,
      abi: perpsSimpleAbi,
      eventName: eventName as "Transfer",
      onLogs: onLogs as Parameters<typeof this.publicClient.watchContractEvent>[0] extends {
        onLogs: infer F;
      }
        ? F
        : never,
      onError: (error) => this.logger.error({ err: error, eventName }, "Event watcher error"),
    });
    this.unwatchFns.push(unwatch);
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

  private onPositionTrade(user: Address, netQuantityAfter: bigint, entryPriceAfter: bigint): void {
    if (netQuantityAfter === 0n) {
      this.users.delete(user);
      this.logger.info({ user }, "Position closed via PositionTrade (zero quantity)");
      return;
    }

    const existing = this.users.get(user);
    if (existing) {
      // Update position from event args — zero RPC
      existing.netQuantity = netQuantityAfter;
      existing.entryPrice = entryPriceAfter;
      existing.isLong = netQuantityAfter > 0n;
      this.recomputeLiquidationPrice(existing);
      this.logger.debug(
        {
          user,
          netQuantity: netQuantityAfter,
          entryPrice: entryPriceAfter,
          liqPrice: existing.liquidationPrice,
        },
        "Position updated",
      );
    } else {
      // New user — need balance + order margin from contract (one-time)
      this.initializeNewUser(user, netQuantityAfter, entryPriceAfter);
    }
  }

  private onPositionClosed(user: Address): void {
    // PositionClosed fires for both partial and full closes.
    // Partial: PositionTrade also fires and already updated state.
    // Full (no flip): only PositionClosed fires — verify on-chain to be safe.
    this.verifyAndRemoveIfClosed(user);
  }

  private onPositionLiquidated(user: Address): void {
    this.users.delete(user);
    this.logger.info({ user }, "Position liquidated (removed from tracker)");
  }

  private onOrderEvent(user: Address): void {
    // Order margin changed — lightweight multicall (2 reads)
    this.recomputeFromContract(user).catch((err) =>
      this.logger.error({ err, user }, "Failed to recompute from contract"),
    );
  }

  // ── Async helpers ─────────────────────────────────────────────────────

  private async initializeNewUser(
    user: Address,
    netQuantity: bigint,
    entryPrice: bigint,
  ): Promise<void> {
    try {
      const results = await this.publicClient.multicall({
        contracts: [
          {
            address: this.config.perpsAddress,
            abi: perpsSimpleAbi,
            functionName: "balanceOf",
            args: [user],
          },
          {
            address: this.config.perpsAddress,
            abi: perpsSimpleAbi,
            functionName: "getMaintenanceMargin",
            args: [user],
          },
          {
            address: this.config.perpsAddress,
            abi: perpsSimpleAbi,
            functionName: "getMarketPrice",
          },
        ],
        allowFailure: false,
      });

      const balance = results[0] as bigint;
      const maintenanceMargin = results[1] as bigint;
      const marketPrice = results[2] as bigint;

      const { orderMargin, liquidationPrice } = computeLiquidationState(
        netQuantity,
        entryPrice,
        balance,
        maintenanceMargin,
        marketPrice,
        this.maintenanceMarginPercent,
        this.quantityDecimals,
      );

      this.users.set(user, {
        address: user,
        netQuantity,
        entryPrice,
        collateral: balance,
        orderMargin,
        liquidationPrice,
        isLong: netQuantity > 0n,
      });

      this.logger.info(
        { user, netQuantity, entryPrice, collateral: balance, orderMargin, liquidationPrice },
        "New user tracked",
      );
    } catch (err) {
      this.logger.error({ err, user }, "Failed to initialize new user");
    }
  }

  private async verifyAndRemoveIfClosed(user: Address): Promise<void> {
    try {
      const position = (await this.publicClient.readContract({
        address: this.config.perpsAddress,
        abi: perpsSimpleAbi,
        functionName: "getUserPosition",
        args: [user],
      })) as { netQuantity: bigint; aggregatedEntryPrice: bigint };

      if (position.netQuantity === 0n) {
        this.users.delete(user);
        this.logger.info({ user }, "Position fully closed (verified on-chain)");
      }
    } catch (err) {
      this.logger.error({ err, user }, "Failed to verify position close");
    }
  }

  private async recomputeFromContract(user: Address): Promise<void> {
    const existing = this.users.get(user);
    if (!existing) return;

    const results = await this.publicClient.multicall({
      contracts: [
        {
          address: this.config.perpsAddress,
          abi: perpsSimpleAbi,
          functionName: "getMaintenanceMargin",
          args: [user],
        },
        { address: this.config.perpsAddress, abi: perpsSimpleAbi, functionName: "getMarketPrice" },
      ],
      allowFailure: false,
    });

    const maintenanceMargin = results[0] as bigint;
    const marketPrice = results[1] as bigint;

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
