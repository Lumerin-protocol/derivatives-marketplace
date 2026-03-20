#!/bin/bash
# Verify The Graph deployment on-chain
#
# Usage: ./scripts/verify-deployment.sh <expected_ipfs_cid>
#
# This script checks:
# 1. What deployment is currently published on-chain (GNS contract)
# 2. Converts the expected IPFS CID to bytes32 for comparison
# 3. Verifies they match

set -e

EXPECTED_CID="${1:-}"
GNS_CONTRACT="0xec9A7fb6CbC2E41926127929c2dcE6e9c5D33Bec"
SUBGRAPH_ID="58571252410525064520208571225029055344406958033018782723127366772434388041155"

if [ -z "$EXPECTED_CID" ]; then
  echo "❌ Error: Please provide the expected IPFS CID"
  echo ""
  echo "Usage: $0 <expected_ipfs_cid>"
  echo ""
  echo "Example: $0 QmQq5pWD7UotMbaDuttyAfPULTzb5qGwrEy7eu7J7tVoDc"
  exit 1
fi

# Use public RPC by default (read-only queries don't need private RPC)
if [ -z "$ARBITRUM_RPC_URL" ]; then
  ARBITRUM_RPC_URL="https://arb1.arbitrum.io/rpc"
  echo "ℹ️  Using public Arbitrum RPC: $ARBITRUM_RPC_URL"
  echo ""
fi

echo "🔍 Verifying Derivatives Subgraph Deployment"
echo "=============================================="
echo ""
echo "Expected CID:  $EXPECTED_CID"
echo "GNS Contract:  $GNS_CONTRACT"
echo "Subgraph ID:   $SUBGRAPH_ID"
echo ""

# Convert expected CID to bytes32
echo "📐 Converting CID to bytes32..."
EXPECTED_BYTES32=$(python3 -c "
ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
def b58decode(s):
    n = 0
    for c in s:
        n = n * 58 + ALPHABET.index(c)
    result = n.to_bytes(max(1, (n.bit_length() + 7) // 8), 'big')
    pad = len(s) - len(s.lstrip('1'))
    return b'\x00' * pad + result
raw = b58decode('$EXPECTED_CID')
print('0x' + raw[2:].hex())
")

echo "   Expected bytes32: $EXPECTED_BYTES32"
echo ""

# Query on-chain deployment
echo "🔗 Querying GNS contract on-chain..."
ONCHAIN_RESULT=$(cast call \
  --rpc-url "$ARBITRUM_RPC_URL" \
  "$GNS_CONTRACT" \
  "subgraphs(uint256)(uint256,bytes32,uint256,bool,uint256)" \
  "$SUBGRAPH_ID" 2>&1)

if [ $? -ne 0 ]; then
  echo "❌ Failed to query GNS contract"
  echo "   Error: $ONCHAIN_RESULT"
  exit 1
fi

# Parse result (line 2 is the deployment ID)
ONCHAIN_DEPLOYMENT=$(echo "$ONCHAIN_RESULT" | sed -n '2p')
VERSION_COUNT=$(echo "$ONCHAIN_RESULT" | sed -n '1p')

echo "   On-chain deployment: $ONCHAIN_DEPLOYMENT"
echo "   Version count: $VERSION_COUNT"
echo ""

# Compare
if [ "$ONCHAIN_DEPLOYMENT" = "$EXPECTED_BYTES32" ]; then
  echo "✅ VERIFIED: On-chain deployment matches expected CID!"
  echo ""
  echo "The subgraph deployed on The Graph Network is:"
  echo "   IPFS: $EXPECTED_CID"
  echo "   Bytes32: $EXPECTED_BYTES32"
  echo ""
  echo "🌐 Studio URL: https://thegraph.com/studio/subgraph/lumerin-dev-derivatives/"
  exit 0
else
  echo "❌ MISMATCH: On-chain deployment does not match expected CID"
  echo ""
  echo "Expected: $EXPECTED_BYTES32"
  echo "On-chain: $ONCHAIN_DEPLOYMENT"
  echo ""
  echo "This means a different version is published on The Graph Network."
  exit 1
fi
