#!/bin/bash
# Local build script for Derivatives Marketplace Subgraph
# This script will build the subgraph locally and deploy it to Goldsky
# It will also create a tag for the subgraph
# Need to have the following environment variables set:
# GOLDSKY_API_KEY

set -e

set -a && source ../.env && set +a

GOLDSKY_SUBGRAPH_NAME=lumerin-derivatives
SUBGRAPH_SEMVER=1.0.0
GOLDSKY_ROLLING_TAG=dev-latest

pnpm install
pnpm prepare-local
pnpm codegen
pnpm build
# Clean previous deployment (tag first, then subgraph — both may not exist, so don't fail)
goldsky subgraph tag delete "${GOLDSKY_SUBGRAPH_NAME}/${SUBGRAPH_SEMVER}" --tag "${GOLDSKY_ROLLING_TAG}" --token "${GOLDSKY_API_KEY}" --force 2>/dev/null || true
goldsky subgraph delete "${GOLDSKY_SUBGRAPH_NAME}/${SUBGRAPH_SEMVER}" --token "${GOLDSKY_API_KEY}" --force 2>/dev/null || true

goldsky subgraph deploy "${GOLDSKY_SUBGRAPH_NAME}/${SUBGRAPH_SEMVER}" --path . --token "${GOLDSKY_API_KEY}"
goldsky subgraph tag create "${GOLDSKY_SUBGRAPH_NAME}/${SUBGRAPH_SEMVER}" --tag "${GOLDSKY_ROLLING_TAG}" --token "${GOLDSKY_API_KEY}"
