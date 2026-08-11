#!/usr/bin/env bash
# Release helper — creates annotated tag and GitHub Release
set -euo pipefail

VERSION="${1:-v0.1.0}"
TAG_MSG="v0.1.0 — Initial testnet release: HTTP 402 gateway, Soroban contracts, SDK, dashboard"

echo "Creating annotated tag ${VERSION}..."
git tag -a "${VERSION}" -m "${TAG_MSG}"

echo "Pushing tag..."
git push origin "${VERSION}"

echo "✅ Tag ${VERSION} pushed. Now create release at:"
echo "   https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway/releases/new?tag=${VERSION}"
echo "   (Mark as pre-release, use CHANGELOG.md [0.1.0] section for notes)"
