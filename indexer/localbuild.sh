#!/bin/bash
# Local build script for Derivatives (perps) subgraph — Goldsky deploy
# This script will build the subgraph locally and deploy it to Goldsky
# It will also create a tag for the subgraph
# Need to have the following environment variables set:
# GOLDSKY_API_KEY

set -euo pipefail

ENV_FILE="${ENV_FILE:-../config/dev.env}"
case "$ENV_FILE" in */*) ;; *) ENV_FILE="./$ENV_FILE" ;; esac
set -a && . "$ENV_FILE" && set +a
if [ -f ../.env ]; then
  set -a && . ../.env && set +a
fi

GOLDSKY_SUBGRAPH_NAME="${GOLDSKY_SUBGRAPH_NAME:-hpow-derivatives}"
GRAFT_FROM="${GRAFT_FROM:-lumerin-derivatives}"
GRAFT_FROM_VERSION="${GRAFT_FROM_VERSION:-v3.0.125-dev}"

pnpm install
ENV_FILE="$ENV_FILE" pnpm prepare:env
pnpm codegen
pnpm build

# Clean previous deployment (tag first, then subgraph — both may not exist, so don't fail)
# goldsky subgraph tag delete "${GOLDSKY_SUBGRAPH_NAME}/${SUBGRAPH_SEMVER}" --tag "${GOLDSKY_ROLLING_TAG}" --token "${GOLDSKY_API_KEY}" --force 2>/dev/null || true
# goldsky subgraph delete "${GOLDSKY_SUBGRAPH_NAME}/${SUBGRAPH_SEMVER}" --token "${GOLDSKY_API_KEY}" --force 2>/dev/null || true

# New Deploy
goldsky subgraph deploy "${GOLDSKY_SUBGRAPH_NAME}/${SUBGRAPH_SEMVER}" --path . --token "${GOLDSKY_API_KEY}"

# Graft the subgraph to the Goldsky subgraph
# goldsky subgraph deploy "${GOLDSKY_SUBGRAPH_NAME}/${SUBGRAPH_SEMVER}" --path . --graft-from "${GRAFT_FROM}/${GRAFT_FROM_VERSION}" --token "${GOLDSKY_API_KEY}"

goldsky subgraph tag create "${GOLDSKY_SUBGRAPH_NAME}/${SUBGRAPH_SEMVER}" --tag "${GOLDSKY_ROLLING_TAG}" --token "${GOLDSKY_API_KEY}"
