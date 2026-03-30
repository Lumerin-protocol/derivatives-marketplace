#!/bin/bash
# Local build script for Derivatives (perps) subgraph — Goldsky deploy
# This script will build the subgraph locally and deploy it to Goldsky
# It will also create a tag for the subgraph
# Need to have the following environment variables set:
# GOLDSKY_API_KEY

set -e

set -a && source ../.env && set +a

GOLDSKY_SUBGRAPH_NAME="${GOLDSKY_SUBGRAPH_NAME:-hpow-derivatives}"
GOLDSKY_ROLLING_TAG="${GOLDSKY_ROLLING_TAG:-dev-latest}"
SUBGRAPH_SEMVER="${SUBGRAPH_SEMVER:-1.0.0}"
GRAFT_FROM="${GRAFT_FROM:-lumerin-derivatives}"
GRAFT_FROM_VERSION="${GRAFT_FROM_VERSION:-v3.0.125-dev}"

pnpm install
pnpm prepare-local
pnpm codegen
pnpm build

# Clean previous deployment (tag first, then subgraph — both may not exist, so don't fail)
# goldsky subgraph tag delete "${GOLDSKY_SUBGRAPH_NAME}/${SUBGRAPH_SEMVER}" --tag "${GOLDSKY_ROLLING_TAG}" --token "${GOLDSKY_API_KEY}" --force 2>/dev/null || true
# goldsky subgraph delete "${GOLDSKY_SUBGRAPH_NAME}/${SUBGRAPH_SEMVER}" --token "${GOLDSKY_API_KEY}" --force 2>/dev/null || true

# New Deploy 
# goldsky subgraph deploy "${GOLDSKY_SUBGRAPH_NAME}/${SUBGRAPH_SEMVER}" --path . --token "${GOLDSKY_API_KEY}"

# Graft the subgraph to the Goldsky subgraph
goldsky subgraph deploy "${GOLDSKY_SUBGRAPH_NAME}/${SUBGRAPH_SEMVER}" --path . --graft-from "${GRAFT_FROM}/${GRAFT_FROM_VERSION}" --token "${GOLDSKY_API_KEY}" 
goldsky subgraph tag create "${GOLDSKY_SUBGRAPH_NAME}/${SUBGRAPH_SEMVER}" --tag "${GOLDSKY_ROLLING_TAG}" --token "${GOLDSKY_API_KEY}"