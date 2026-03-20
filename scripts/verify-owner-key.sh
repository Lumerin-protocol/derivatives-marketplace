#!/bin/bash
# Quick script to verify the GNS_OWNER_KEY matches the subgraph NFT owner

if [ -z "$GNS_OWNER_KEY" ]; then
  echo "❌ GNS_OWNER_KEY not set"
  echo "Usage: export GNS_OWNER_KEY='0x...' && ./scripts/verify-owner-key.sh"
  exit 1
fi

echo "Verifying key ownership..."
echo ""

# Get address from private key
KEY_ADDRESS=$(cast wallet address "$GNS_OWNER_KEY" 2>&1)

if [ $? -ne 0 ]; then
  echo "❌ Invalid private key format"
  echo "Error: $KEY_ADDRESS"
  exit 1
fi

echo "✓ Key is valid"
echo "  Address from key: $KEY_ADDRESS"
echo ""

# Get actual NFT owner
NFT_OWNER=$(cast call --rpc-url https://arb1.arbitrum.io/rpc \
  0xec9A7fb6CbC2E41926127929c2dcE6e9c5D33Bec \
  "ownerOf(uint256)(address)" \
  58571252410525064520208571225029055344406958033018782723127366772434388041155)

echo "  NFT owner:        $NFT_OWNER"
echo ""

KEY_ADDRESS_LOWER=$(echo "$KEY_ADDRESS" | tr '[:upper:]' '[:lower:]')
NFT_OWNER_LOWER=$(echo "$NFT_OWNER" | tr '[:upper:]' '[:lower:]')

if [ "$KEY_ADDRESS_LOWER" = "$NFT_OWNER_LOWER" ]; then
  echo "✅ MATCH! Your key owns this subgraph NFT."
  echo ""
  echo "The revert is likely because deprecated subgraphs cannot be undeprecated."
  echo "Recommendation: Create a new subgraph NFT."
else
  echo "❌ MISMATCH! Your key does NOT own this subgraph NFT."
  echo ""
  echo "You need the private key for: $NFT_OWNER"
fi
