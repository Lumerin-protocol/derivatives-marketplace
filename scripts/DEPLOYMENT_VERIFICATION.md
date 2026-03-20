# Deployment Verification Guide

Since The Graph Studio UI doesn't always reflect the on-chain published state (when publishing is done via direct contract calls), here are ways to verify what's actually deployed.

## Quick Verification Commands

### 1. Check Current On-Chain Deployment

Use the provided script (uses public RPC by default):

```bash
# Query current deployment status
./scripts/query-current-deployment.sh

# Or use a custom RPC URL
export ARBITRUM_RPC_URL="https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY"
./scripts/query-current-deployment.sh
```

**What it shows:**
- Studio latest deployment CID
- On-chain published deployment ID
- Whether they match
- Current indexing block and error status

### 2. Verify Specific CID is Deployed

```bash
./scripts/verify-deployment.sh QmQq5pWD7UotMbaDuttyAfPULTzb5qGwrEy7eu7J7tVoDc
```

Replace with the CID from your GitHub Actions run output.

## Manual Verification (no scripts)

### Query On-Chain using cast

```bash
# Using public RPC (no API key needed)
cast call \
  --rpc-url https://arb1.arbitrum.io/rpc \
  0xec9A7fb6CbC2E41926127929c2dcE6e9c5D33Bec \
  "subgraphs(uint256)(uint256,bytes32,uint256,bool,uint256)" \
  58571252410525064520208571225029055344406958033018782723127366772434388041155

# Or use your own RPC
cast call \
  --rpc-url $ARBITRUM_RPC_URL \
  0xec9A7fb6CbC2E41926127929c2dcE6e9c5D33Bec \
  "subgraphs(uint256)(uint256,bytes32,uint256,bool,uint256)" \
  58571252410525064520208571225029055344406958033018782723127366772434388041155
```

**Returns:**
```
<versionCount>        # Line 1: Number of versions published
<deploymentID>        # Line 2: bytes32 hash of current IPFS deployment
<versionCreatedAt>    # Line 3: Timestamp
<deprecated>          # Line 4: Boolean
<reserveRatio>        # Line 5: Number
```

The important one is **Line 2** - this is the `bytes32` representation of the IPFS CID currently published.

### Convert IPFS CID to bytes32

To compare the on-chain deployment ID with an IPFS CID:

```bash
python3 -c "
ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
def b58decode(s):
    n = 0
    for c in s:
        n = n * 58 + ALPHABET.index(c)
    result = n.to_bytes(max(1, (n.bit_length() + 7) // 8), 'big')
    pad = len(s) - len(s.lstrip('1'))
    return b'\x00' * pad + result
raw = b58decode('QmQq5pWD7UotMbaDuttyAfPULTzb5qGwrEy7eu7J7tVoDc')
print('0x' + raw[2:].hex())
"
```

Replace `QmQq5p...` with your actual CID.

### Query Studio API

```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{"query": "{ _meta { deployment block { number } hasIndexingErrors } }"}' \
  "https://api.studio.thegraph.com/query/1724245/lumerin-dev-derivatives/version/latest" | jq
```

**Returns:**
```json
{
  "data": {
    "_meta": {
      "deployment": "QmXXX...",    // Current IPFS CID in Studio
      "block": {
        "number": 12345678
      },
      "hasIndexingErrors": false
    }
  }
}
```

## Understanding the Issue

### Why Studio shows "Publish" button when already published:

The workflow publishes directly to The Graph Network by calling the GNS contract with `cast send`. This is efficient and reliable, but **The Graph Studio UI doesn't track this** - it only knows about publishes done through Studio's own API.

**Result:**
- ✅ The subgraph IS published on-chain and live
- ❌ Studio UI doesn't show "Published" status
- ❌ Clicking "Publish" in Studio fails because it's already published on-chain

### Solutions:

**Option A: Trust the workflow, ignore Studio button**
- The workflow is publishing correctly
- Use the verification scripts above to confirm
- Ignore the Studio "Publish" button

**Option B: Disable auto-publish in workflow**
- Remove the auto-publish step from the workflow
- Manually click "Publish" in Studio UI after each deploy
- Studio UI will then correctly show the published status

## Recommended for Devs

Share these one-liners with your team:

```bash
# Quick check - what's deployed on-chain? (uses public RPC, no API key needed)
cast call --rpc-url https://arb1.arbitrum.io/rpc \
  0xec9A7fb6CbC2E41926127929c2dcE6e9c5D33Bec \
  "subgraphs(uint256)(uint256,bytes32,uint256,bool,uint256)" \
  58571252410525064520208571225029055344406958033018782723127366772434388041155 | sed -n '2p'
```

**Public Arbitrum RPC endpoints** (no API key required):
- `https://arb1.arbitrum.io/rpc` (official)
- `https://arbitrum.llamarpc.com`
- `https://arbitrum-one.publicnode.com`
- `https://rpc.ankr.com/arbitrum`

This returns the bytes32 hash of the currently published deployment on The Graph Network.

## Key Constants

- **GNS Contract (Arbitrum):** `0xec9A7fb6CbC2E41926127929c2dcE6e9c5D33Bec`
- **Subgraph ID:** `58571252410525064520208571225029055344406958033018782723127366772434388041155`
- **Studio Name:** `lumerin-dev-derivatives`
- **User ID:** `1724245`

## Links

- **Studio Dashboard:** https://thegraph.com/studio/subgraph/lumerin-dev-derivatives/
- **Studio Endpoint:** https://api.studio.thegraph.com/query/1724245/lumerin-dev-derivatives/version/latest
- **GNS Contract (Arbiscan):** https://arbiscan.io/address/0xec9A7fb6CbC2E41926127929c2dcE6e9c5D33Bec
