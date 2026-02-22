# E2E Tests

End-to-end tests that exercise the full stack: Hardhat node, contract deployment, subgraph indexing (Graph Node), and the keeper liquidation bot.

## Prerequisites

- Node.js >= 22.6.0
- pnpm
- Docker & Docker Compose

## Quick Start

```bash
# From the e2e/ directory:

# 1. Install dependencies
pnpm install

# 2. Start the Docker stack (Hardhat, Graph Node, IPFS, Postgres)
pnpm up

# 3. Run the tests
pnpm test
```

## Commands

| Command | Description |
| ------------ | ---------------------------------------------------------------------- |
| `pnpm up` | Start the Docker stack in the background |
| `pnpm down` | Stop the stack and remove volumes |
| `pnpm reset` | Tear down, wipe all data, and rebuild from scratch |
| `pnpm test` | Run all e2e tests |
| `pnpm test:bail` | Run tests, stopping at the first failure |

## What the Tests Do

1. **Setup** (runs once before all tests):
   - Waits for the Docker stack to be reachable
   - Compiles and deploys the contracts to the Hardhat node
   - Deploys the subgraph to Graph Node
   - Starts the keeper process

2. **Deployment** — verifies contracts deployed successfully
3. **Subgraph indexing** — checks that orders, trades, and positions are indexed
4. **Keeper liquidation** — moves the price to make a position liquidatable, waits for the keeper to execute the liquidation on-chain, and verifies the subgraph indexes the event

## Architecture

```
Host machine                         Docker
┌──────────────────┐      ┌─────────────────────────┐
│ Test runner       │      │ Hardhat node  (:8545)   │
│ Keeper process    │◄────►│ Graph Node    (:8000)   │
│                   │      │ IPFS          (:5001)   │
│                   │      │ Postgres      (:5432)   │
└──────────────────┘      └─────────────────────────┘
```

The test runner and keeper run on the host and connect to the Dockerized services via exposed ports.

## Troubleshooting

- **Stale state**: Run `pnpm reset` to wipe volumes and rebuild.
- **Port conflicts**: Ensure ports 5001, 5432, 8000, 8020, and 8545 are free.
- **Keeper won't stop**: The test teardown kills the keeper's process group. If a zombie persists, check for orphaned processes on port 3001.
