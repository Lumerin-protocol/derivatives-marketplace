# @hashpower/perps-abi

ABIs and deployment addresses for the Hashpower perpetuals CLOB on Base.

`HashPowerPerpsDEX` is an on-chain central limit order book for hashprice perpetuals:

| Action | Function |
| --- | --- |
| Place / match a limit order | `createOrder(price, quantity)` — signed quantity: + buy, − sell |
| Cancel a resting order | `cancelOrder(orderId)` |
| Preview a fill | `simulateOrder(price, quantity)` (view) |
| Read the book | `getOrderBookPrices`, `getBestBidPrice`, `getBestAskPrice`, `getQuantityAtPrice` |
| Margin / PnL | `getInitialMargin`, `getMaintenanceMargin`, `getUnrealizedPnl`, `getPendingFunding` |

Collateral flows through the shared `CollateralVault` (see `@hashpower/collateral-abi`) — deposit USDC there before trading.

## Usage

```ts
import { HashPowerPerpsDEXAbi } from "@hashpower/perps-abi";
import deployments from "@hashpower/perps-abi/deployments.json" with { type: "json" };

// "testnet" (Base Sepolia) or "mainnet" (Base)
const env = process.env.HASHPOWER_ENV ?? "testnet";
const { contracts, subgraphs } = deployments.environments[env];

const [bestBid] = await client.readContract({
  address: contracts.HashPowerPerpsDEX,
  abi: HashPowerPerpsDEXAbi,
  functionName: "getBestBidPrice",
});
```

Order books, positions, fills, and funding history are indexed by the perps subgraph (`subgraphs.perps` in `deployments.json`).

Raw JSON ABIs (for subgraphs and non-TypeScript consumers) are available under `@hashpower/perps-abi/json/<Contract>.json`.

## How this package is built

Contents are generated — do not edit by hand:

- `src/` is copied from `../contracts/abi` (the Hardhat codegen output, mocks excluded) by `scripts/build.mjs`, then compiled to `dist/`.
- `deployments.json` is the canonical address manifest for this repo; it is updated when contracts are (re)deployed.

Publishing happens automatically from CI when ABIs or the manifest change (see `.github/workflows/publish-perps-abi.yml`).
