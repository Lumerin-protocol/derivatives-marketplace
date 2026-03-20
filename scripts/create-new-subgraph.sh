#!/bin/bash
set -e

# Script to create a NEW subgraph NFT on The Graph Network
# Requires: Foundry (cast)
# Required env var: GNS_OWNER_KEY (private key of the wallet that will own the new subgraph)

GNS_CONTRACT="0xec9A7fb6CbC2E41926127929c2dcE6e9c5D33Bec"
ARBITRUM_RPC="${ARBITRUM_RPC_URL:-https://arb1.arbitrum.io/rpc}"

if [ -z "$GNS_OWNER_KEY" ]; then
  echo "❌ Error: GNS_OWNER_KEY environment variable not set"
  echo ""
  echo "Usage:"
  echo "  export GNS_OWNER_KEY='0x...'"
  echo "  ./scripts/create-new-subgraph.sh"
  exit 1
fi

OWNER_ADDRESS=$(cast wallet address "$GNS_OWNER_KEY")

echo "🎨 Creating new subgraph NFT on The Graph Network..."
echo ""
echo "GNS Contract:  $GNS_CONTRACT"
echo "Owner:         $OWNER_ADDRESS"
echo "RPC:           $ARBITRUM_RPC"
echo ""

# Generate a unique subgraph number (using timestamp + random)
TIMESTAMP=$(date +%s)
RANDOM_SUFFIX=$((RANDOM % 10000))
SUBGRAPH_NUMBER="${TIMESTAMP}${RANDOM_SUFFIX}"

# Convert to bytes32 (pad with zeros on the left)
SUBGRAPH_NUMBER_HEX=$(printf "0x%064x" $SUBGRAPH_NUMBER)

echo "Subgraph Details:"
echo "  Number:        $SUBGRAPH_NUMBER"
echo "  Number (hex):  $SUBGRAPH_NUMBER_HEX"
echo ""

# The account ID is typically keccak256(owner_address)
# But for simplicity, we'll use a deterministic value
ACCOUNT_ID=$(cast keccak "lumerin-derivatives-$(date +%Y%m%d)")

echo "  Account ID:    $ACCOUNT_ID"
echo ""

read -p "Proceed with creating new subgraph? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Cancelled."
  exit 0
fi

echo ""
echo "🚀 Calling publishNewSubgraph()..."
echo ""

# Create subgraph with metadata
VERSION_METADATA="0x0000000000000000000000000000000000000000000000000000000000000000"

RESULT=$(cast send \
  --private-key "$GNS_OWNER_KEY" \
  --rpc-url "$ARBITRUM_RPC" \
  --json \
  "$GNS_CONTRACT" \
  "publishNewSubgraph(bytes32,bytes32,bytes32)" \
  "$ACCOUNT_ID" \
  "$SUBGRAPH_NUMBER_HEX" \
  "$VERSION_METADATA")

TX_HASH=$(echo "$RESULT" | jq -r '.transactionHash')
TX_STATUS=$(echo "$RESULT" | jq -r '.status')
GAS_USED=$(echo "$RESULT" | jq -r '.gasUsed')

if [ "$TX_STATUS" != "0x1" ] && [ "$TX_STATUS" != "1" ]; then
  echo "❌ Transaction reverted (status: $TX_STATUS)"
  echo "   Tx: https://arbiscan.io/tx/$TX_HASH"
  exit 1
fi

echo "✅ New subgraph created successfully!"
echo ""
echo "   Tx Hash:  $TX_HASH"
echo "   Gas Used: $GAS_USED"
echo "   Explorer: https://arbiscan.io/tx/$TX_HASH"
echo ""

# Get the subgraph ID from the transaction logs
echo "🔍 Extracting Subgraph ID from transaction..."
LOGS=$(cast receipt --json --rpc-url "$ARBITRUM_RPC" "$TX_HASH" | jq -r '.logs[]')

# SubgraphPublished event signature: 0xb8403eababf84b56895bcb4e5a41380ef4e9cf7a12b5815ed5760bd9a4e31c67
SUBGRAPH_ID_HEX=$(echo "$LOGS" | jq -r 'select(.topics[0] == "0xb8403eababf84b56895bcb4e5a41380ef4e9cf7a12b5815ed5760bd9a4e31c67") | .topics[1]' | head -1)

if [ -z "$SUBGRAPH_ID_HEX" ] || [ "$SUBGRAPH_ID_HEX" = "null" ]; then
  echo "⚠️  Could not automatically extract Subgraph ID from logs."
  echo "   Check transaction on Arbiscan: https://arbiscan.io/tx/$TX_HASH"
  exit 1
fi

SUBGRAPH_ID_DECIMAL=$(cast to-dec "$SUBGRAPH_ID_HEX")

echo "✅ Subgraph ID extracted:"
echo ""
echo "   Hex:     $SUBGRAPH_ID_HEX"
echo "   Decimal: $SUBGRAPH_ID_DECIMAL"
echo ""

# Save to file for easy reference
echo "$SUBGRAPH_ID_DECIMAL" > scripts/.new-subgraph-id
echo "   Saved to: scripts/.new-subgraph-id"
echo ""

echo "📋 Next steps:"
echo ""
echo "1. Update GitHub variable:"
echo "   gh variable set GNS_SUBGRAPH_ID \\"
echo "     --env dev \\"
echo "     --repo Lumerin-protocol/derivatives-marketplace \\"
echo "     --body \"$SUBGRAPH_ID_DECIMAL\""
echo ""
echo "2. Repeat for STG and PRD environments if needed"
echo ""
echo "3. Trigger workflow to publish first version"
echo ""
echo "4. Update gateway URL in documentation (will be different)"
