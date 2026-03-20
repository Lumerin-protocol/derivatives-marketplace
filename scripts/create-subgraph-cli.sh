#!/bin/bash
set -e

# Create a new subgraph on The Graph Network using the Graph CLI
# This is the recommended approach as it handles all the contract interactions correctly

if [ -z "$GRAPH_DEPLOY_KEY" ]; then
  echo "❌ Error: GRAPH_DEPLOY_KEY environment variable not set"
  echo ""
  echo "Get your deploy key from: https://thegraph.com/studio/"
  echo ""
  echo "Usage:"
  echo "  export GRAPH_DEPLOY_KEY='...'"
  echo "  ./scripts/create-subgraph-cli.sh"
  exit 1
fi

SUBGRAPH_NAME="lumerin-derivatives-v2"

echo "🎨 Creating new subgraph via Graph CLI..."
echo ""
echo "Subgraph name: $SUBGRAPH_NAME"
echo ""

cd indexer

# Create the subgraph (this will prompt for network selection)
echo "📝 Creating subgraph on The Graph Studio..."
npx graph create --node https://api.thegraph.com/deploy/ "$SUBGRAPH_NAME"

echo ""
echo "✅ Subgraph created!"
echo ""
echo "📋 Next steps:"
echo ""
echo "1. Go to https://thegraph.com/studio/"
echo "2. Find your new subgraph: $SUBGRAPH_NAME"
echo "3. Get the Subgraph ID (large decimal number) from the Studio UI"
echo "4. Update GitHub variables:"
echo ""
echo "   gh variable set GNS_SUBGRAPH_ID \\"
echo "     --env dev \\"
echo "     --repo Lumerin-protocol/derivatives-marketplace \\"
echo "     --body \"<SUBGRAPH_ID_FROM_STUDIO>\""
echo ""
echo "5. Trigger workflow to publish first version"
