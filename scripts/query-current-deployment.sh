#!/bin/bash
# Query current deployment from both Studio and on-chain
#
# Usage: ./scripts/query-current-deployment.sh
#
# This shows you what's currently deployed in:
# 1. The Graph Studio (latest version)
# 2. The Graph Network (on-chain GNS contract)

set -e

GNS_CONTRACT="0xec9A7fb6CbC2E41926127929c2dcE6e9c5D33Bec"
SUBGRAPH_ID="58571252410525064520208571225029055344406958033018782723127366772434388041155"
SUBGRAPH_NAME="lumerin-dev-derivatives"
USERID="1724245"

echo "🔍 Current Derivatives Subgraph Deployment Status"
echo "=================================================="
echo ""

# Query Studio API
echo "📊 Studio (latest version):"
STUDIO_RESPONSE=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{"query": "{ _meta { deployment block { number } hasIndexingErrors } }"}' \
  "https://api.studio.thegraph.com/query/${USERID}/${SUBGRAPH_NAME}/version/latest" 2>/dev/null || echo "{}")

STUDIO_CID=$(echo "$STUDIO_RESPONSE" | jq -r '.data._meta.deployment // "N/A"')
STUDIO_BLOCK=$(echo "$STUDIO_RESPONSE" | jq -r '.data._meta.block.number // "N/A"')
STUDIO_ERRORS=$(echo "$STUDIO_RESPONSE" | jq -r '.data._meta.hasIndexingErrors // "N/A"')

echo "   Deployment CID: $STUDIO_CID"
echo "   Block indexed:  $STUDIO_BLOCK"
echo "   Has errors:     $STUDIO_ERRORS"
echo ""

# Use public RPC by default (read-only queries)
if [ -z "$ARBITRUM_RPC_URL" ]; then
  ARBITRUM_RPC_URL="https://arb1.arbitrum.io/rpc"
fi

# Query on-chain
if command -v cast &> /dev/null; then
  echo "🔗 On-Chain (The Graph Network):"
  
  ONCHAIN_RESULT=$(cast call \
    --rpc-url "$ARBITRUM_RPC_URL" \
    "$GNS_CONTRACT" \
    "subgraphs(uint256)(uint256,bytes32,uint256,bool,uint256)" \
    "$SUBGRAPH_ID" 2>&1)
  
  if [ $? -eq 0 ]; then
    ONCHAIN_DEPLOYMENT=$(echo "$ONCHAIN_RESULT" | sed -n '2p')
    VERSION_COUNT=$(echo "$ONCHAIN_RESULT" | sed -n '1p')
    
    # Convert Studio CID to bytes32 for comparison
    if [ "$STUDIO_CID" != "N/A" ] && [ -n "$STUDIO_CID" ]; then
      STUDIO_BYTES32=$(python3 -c "
ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
def b58decode(s):
    n = 0
    for c in s:
        n = n * 58 + ALPHABET.index(c)
    result = n.to_bytes(max(1, (n.bit_length() + 7) // 8), 'big')
    pad = len(s) - len(s.lstrip('1'))
    return b'\x00' * pad + result
raw = b58decode('$STUDIO_CID')
print('0x' + raw[2:].hex())
" 2>/dev/null || echo "conversion_failed")
    else
      STUDIO_BYTES32="N/A"
    fi
    
    echo "   Deployment ID:  $ONCHAIN_DEPLOYMENT"
    echo "   Version count:  $VERSION_COUNT"
    echo "   Studio bytes32: $STUDIO_BYTES32"
    echo ""
    
    if [ "$ONCHAIN_DEPLOYMENT" = "$STUDIO_BYTES32" ]; then
      echo "✅ Studio and on-chain deployments MATCH"
    else
      echo "⚠️  Studio and on-chain deployments DIFFER"
      echo "   This means Studio shows a different version than what's published on-chain"
    fi
  else
    echo "   ❌ Could not query GNS contract"
    echo "   Error: $ONCHAIN_RESULT"
  fi
else
  echo "⚠️  On-chain check skipped: 'cast' command not found"
  echo "   Install Foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup"
fi

echo ""
echo "🌐 Studio URL: https://thegraph.com/studio/subgraph/$SUBGRAPH_NAME/"
