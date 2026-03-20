# Creating a New Subgraph NFT

Since subgraph deprecation appears to be permanent, you'll need to create a new subgraph NFT.

## Steps

### 1. Via The Graph Studio UI (Easiest)

1. Go to https://thegraph.com/studio/
2. Connect your wallet (`0x8340859b8149bb1d6021e5935A6F699D6D54621a`)
3. Click "Create a Subgraph"
4. Fill in details (keep the name consistent, e.g., "lumerin-derivatives")
5. After creation, note the new Subgraph ID (it will be a large number)

### 2. Via Contract Call (Advanced)

The GNS contract has a `mintNSignal` function to create and signal on a new subgraph:

```bash
cast send \
  --private-key "$GNS_OWNER_KEY" \
  --rpc-url https://arb1.arbitrum.io/rpc \
  0xec9A7fb6CbC2E41926127929c2dcE6e9c5D33Bec \
  "mintNSignal(bytes32,bytes32,uint256,uint256)" \
  "<subgraph-account-id>" \
  "<subgraph-number-as-bytes32>" \
  "<signal-amount>" \
  "<version-metadata>"
```

## After Creating the New Subgraph

1. Get the new Subgraph ID (a large decimal number or its hex representation)
2. Update GitHub environment variables:

```bash
# For DEV environment
gh variable set GNS_SUBGRAPH_ID \
  --env dev \
  --repo Lumerin-protocol/derivatives-marketplace \
  --body "<NEW_SUBGRAPH_ID>"

# Repeat for STG and PRD if needed
```

3. Trigger a new deployment workflow - it will publish to the new subgraph NFT
4. Update any hardcoded gateway URLs or documentation with the new subgraph ID

## Migration Path

- **Studio**: Will automatically deploy to the new subgraph
- **Decentralized Network**: First publish will create version 1
- **Gateway URL**: Will change to reflect the new subgraph ID
- **Existing curators**: Will need to migrate signal to the new subgraph (they can withdraw from the deprecated one)

## Notes

- The old deprecated subgraph will remain deprecated
- No data is lost - all historical deployments are still on IPFS
- Indexers will automatically pick up the new subgraph once published
- Consider adding initial curation signal to improve query performance
