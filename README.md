# Titan Perps

On-chain perpetual futures trading platform with an order book model, built on Arbitrum.

## Architecture

```
┌───────────┐     ┌──────────────────┐     ┌───────────────────┐
│  Frontend │────▶│  PerpsSimple     │◀────│  Hashprice Oracle │
│  (React)  │     │  (on-chain CLOB) │     │  (Chainlink iface)│
└───────────┘     └──────────────────┘     └───────────────────┘
                         │  events
                         ▼
                  ┌──────────────────┐
                  │  Subgraph        │
                  │  (The Graph)     │
                  └──────────────────┘
                         │  GraphQL
                         ▼
                  ┌──────────────────┐
                  │  Frontend        │
                  │  + Keepers       │
                  └──────────────────┘
```

### Components

**Smart Contracts** (`contracts/`) — The core perpetual trading engine. A single upgradeable `PerpsSimple` contract implements the full on-chain central limit order book, collateral custody, margin accounting, position management, and liquidation logic. See [`contracts/README.md`](contracts/README.md) for implementation details.

**Hashprice Oracle** — An external Chainlink-compatible price oracle ([`hashprice-oracle`](https://github.com/Lumerin-protocol/hashprice-oracle)) that feeds BTC hashprice data to the contract. The contract reads the oracle through the standard `AggregatorV3Interface`, so any Chainlink-style feed can be swapped in.

**Indexer** (`indexer/`) — A Graph Protocol subgraph that listens to contract events and builds a queryable GraphQL API. It tracks the order book, trade history, user positions, collateral events, and aggregated stats. The frontend and any off-chain services consume data from here instead of reading contract state directly. See [`indexer/README.md`](indexer/README.md) for schema and query examples.

**Keepers** (planned) — Off-chain liquidation bots that monitor user positions via the subgraph or direct contract reads. When a position's collateral drops below maintenance margin, keepers call `liquidate(user)` on-chain to close the position and earn the liquidation fee. Not yet implemented.

**Frontend** (planned) — React-based trading UI for placing orders, managing collateral, and viewing positions and trade history. Will be added to this repo, reusing the existing futures UI codebase. Communicates with the contract via wagmi/viem for writes and the subgraph for reads.

### Data Flow

1. **Oracle** pushes price updates on-chain. The contract reads the latest price for margin checks, liquidation eligibility, and mark-to-market calculations.
2. **Users** interact with the contract through the frontend — depositing collateral, placing/cancelling orders, and withdrawing funds.
3. **Matching engine** executes on-chain when `createOrder` is called. Matched trades settle immediately: positions are updated and PnL flows through the reserve pool.
4. **Subgraph** indexes all emitted events into structured entities (orders, trades, positions, price levels, etc.) and serves them over GraphQL.
5. **Frontend** queries the subgraph for order book depth, trade history, and portfolio data to render the UI.
6. **Keepers** (planned) poll for under-collateralized positions and submit liquidation transactions.

## Repository Structure

```
contracts/          Solidity smart contracts (Hardhat + Foundry)
indexer/            Graph Protocol subgraph
```

## Getting Started

### Prerequisites

- Node.js 20.x
- [pnpm](https://pnpm.io/)
- [Foundry](https://book.getfoundry.sh/) (for Solidity formatting)
- Docker (for local subgraph development)

### Contracts

```bash
cd contracts
pnpm install
pnpm test              # Run test suite
pnpm compile           # Generate ABIs via wagmi
pnpm format:sol        # Format Solidity files
pnpm deploy-local      # Deploy to local Hardhat network
```

### Indexer

```bash
cd indexer
pnpm install
cp .env.example .env   # Configure environment variables
pnpm indexer            # Start graph-node via Docker
pnpm setup-local       # Codegen, build, create & deploy subgraph
```

See [`contracts/README.md`](contracts/README.md) and [`indexer/README.md`](indexer/README.md) for more details.

## Tech Stack

| Layer     | Technology                                      |
| --------- | ----------------------------------------------- |
| Contracts | Solidity 0.8.20, OpenZeppelin, Hardhat, Foundry |
| Oracle    | Hashprice Oracle (Chainlink AggregatorV3 iface) |
| Indexer   | The Graph, AssemblyScript                       |
| Frontend  | React, wagmi, viem (planned)                    |
| Keepers   | Off-chain liquidation bots (planned)            |
| Tooling   | pnpm, TypeScript, Biome                         |
| Network   | Arbitrum                                        |

## License

Contracts are licensed under MIT. Indexer is UNLICENSED.
