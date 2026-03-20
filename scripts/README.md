# Deployment Scripts

Tools for verifying and managing The Graph subgraph deployments.

## Verification Scripts

### Quick Status Check

```bash
./scripts/query-current-deployment.sh
```

Shows the current deployment status in both Studio and on-chain (uses public RPC by default).

### Verify Specific CID

```bash
./scripts/verify-deployment.sh QmQq5pWD7UotMbaDuttyAfPULTzb5qGwrEy7eu7J7tVoDc
```

Verifies that a specific IPFS CID is deployed on-chain.

## Requirements

- **Foundry** (`cast` command): `curl -L https://foundry.paradigm.xyz | bash && foundryup`
- **jq**: For JSON parsing (usually pre-installed on most systems)
- **Python 3**: For CID to bytes32 conversion

## No API Key Needed

These scripts use **public Arbitrum RPC endpoints** by default, so you don't need an API key for verification. The scripts will use `https://arb1.arbitrum.io/rpc` automatically.

## Full Documentation

See [DEPLOYMENT_VERIFICATION.md](./DEPLOYMENT_VERIFICATION.md) for:
- Manual verification commands
- Understanding the Studio vs on-chain discrepancy
- All constants and endpoints
- Troubleshooting guide
