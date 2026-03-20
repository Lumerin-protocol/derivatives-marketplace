#!/bin/bash
set -e

# Script to un-deprecate the derivatives subgraph on The Graph Network
# Requires: Foundry (cast)
# Required env var: GNS_OWNER_KEY (private key of the subgraph NFT owner)

GNS_CONTRACT="0xec9A7fb6CbC2E41926127929c2dcE6e9c5D33Bec"
SUBGRAPH_ID="58571252410525064520208571225029055344406958033018782723127366772434388041155"
ARBITRUM_RPC="${ARBITRUM_RPC_URL:-https://arb1.arbitrum.io/rpc}"

if [ -z "$GNS_OWNER_KEY" ]; then
  echo "❌ Error: GNS_OWNER_KEY environment variable not set"
  echo ""
  echo "This must be the private key for: 0x8340859b8149bb1d6021e5935A6F699D6D54621a"
  echo ""
  echo "Usage:"
  echo "  export GNS_OWNER_KEY='0x...'"
  echo "  ./scripts/undeprecate-subgraph.sh"
  exit 1
fi

echo "🔧 Un-deprecating subgraph on The Graph Network..."
echo ""
echo "GNS Contract:  $GNS_CONTRACT"
echo "Subgraph ID:   $SUBGRAPH_ID"
echo "RPC:           $ARBITRUM_RPC"
echo ""

# Check current status
echo "📊 Current status:"
CURRENT=$(cast call --rpc-url "$ARBITRUM_RPC" \
  "$GNS_CONTRACT" \
  "subgraphs(uint256)(uint256,bytes32,uint256,bool,uint256)" \
  "$SUBGRAPH_ID")

DEPRECATED=$(echo "$CURRENT" | sed -n '4p')
echo "   Deprecated: $DEPRECATED"
echo ""

if [ "$DEPRECATED" = "false" ]; then
  echo "✅ Subgraph is already active (not deprecated)"
  exit 0
fi

echo "🚀 Calling setDeprecated(subgraphId, false)..."
echo ""

# Call setDeprecated with false to un-deprecate
RESULT=$(cast send \
  --private-key "$GNS_OWNER_KEY" \
  --rpc-url "$ARBITRUM_RPC" \
  --json \
  "$GNS_CONTRACT" \
  "setDeprecated(uint256,bool)" \
  "$SUBGRAPH_ID" \
  false)

TX_HASH=$(echo "$RESULT" | jq -r '.transactionHash')
TX_STATUS=$(echo "$RESULT" | jq -r '.status')
GAS_USED=$(echo "$RESULT" | jq -r '.gasUsed')

if [ "$TX_STATUS" != "0x1" ] && [ "$TX_STATUS" != "1" ]; then
  echo "❌ Transaction reverted (status: $TX_STATUS)"
  echo "   Tx: https://arbiscan.io/tx/$TX_HASH"
  exit 1
fi

echo "✅ Subgraph un-deprecated successfully!"
echo ""
echo "   Tx Hash:  $TX_HASH"
echo "   Gas Used: $GAS_USED"
echo "   Explorer: https://arbiscan.io/tx/$TX_HASH"
echo ""

# Verify new status
echo "📊 Verifying new status..."
NEW_STATUS=$(cast call --rpc-url "$ARBITRUM_RPC" \
  "$GNS_CONTRACT" \
  "subgraphs(uint256)(uint256,bytes32,uint256,bool,uint256)" \
  "$SUBGRAPH_ID")

NEW_DEPRECATED=$(echo "$NEW_STATUS" | sed -n '4p')
echo "   Deprecated: $NEW_DEPRECATED"
echo ""

if [ "$NEW_DEPRECATED" = "false" ]; then
  echo "✅ Verified: Subgraph is now active!"
  echo ""
  echo "Next steps:"
  echo "  1. Trigger a new deployment workflow to publish a version"
  echo "  2. Check that the production endpoint serves the new version"
else
  echo "⚠️  Warning: Status still shows deprecated=$NEW_DEPRECATED"
fi
