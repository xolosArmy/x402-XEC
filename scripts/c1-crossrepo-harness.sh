#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Phase C1 Cross-Repo Contract Harness Reproducibility Script
# ==============================================================================
# Verifies cross-repo contract interoperability across all 4 pinned repositories:
# - tonalli-core:   cfe4cb1575b22ed258565717c000ac535aa98c67
# - tonalli-agents: b95919ec0b36179b84da88ce48cb23cae30ae311
# - RMZWallet:      860e7223cbe74476efdca81b249d2a7d3c147fbb
# - x402-XEC:       Phase C1 branch HEAD
#
# Classification:
# ⚠️ SCHEMA-ONLY MAINNET-SHAPED SIMULATION (Zero signing, zero broadcast, zero real funds)
# ==============================================================================

if [ -d "/home/xolosarmy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin" ]; then
  export PATH="/home/xolosarmy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Pinned canonical commit SHAs
EXPECTED_CORE_SHA="cfe4cb1575b22ed258565717c000ac535aa98c67"
EXPECTED_AGENTS_SHA="b95919ec0b36179b84da88ce48cb23cae30ae311"
EXPECTED_WALLET_SHA="860e7223cbe74476efdca81b249d2a7d3c147fbb"

TONALLI_CORE_ROOT="${TONALLI_CORE_ROOT:-/home/xolosarmy/ecashschool/tonalli-core/tonalli-core}"
TONALLI_AGENTS_ROOT="${TONALLI_AGENTS_ROOT:-/home/xolosarmy/ecashschool/tonalli-agents}"
RMZ_WALLET_ROOT="${RMZ_WALLET_ROOT:-/home/xolosarmy/ecashschool/RMZWallet}"

echo "=== [Phase C1 Cross-Repo Contract Harness] ==="
echo "Workspace:      $WORKSPACE_ROOT"
echo "tonalli-core:   $TONALLI_CORE_ROOT"
echo "tonalli-agents: $TONALLI_AGENTS_ROOT"
echo "RMZWallet:      $RMZ_WALLET_ROOT"

# Verify pinned repository SHAs
verify_sha() {
  local dir="$1"
  local expected="$2"
  local name="$3"
  if [ -d "$dir/.git" ]; then
    local actual
    actual=$(git -C "$dir" rev-parse HEAD)
    if [ "$actual" != "$expected" ]; then
      echo "ERROR: $name HEAD ($actual) does not match pinned SHA ($expected)" >&2
      exit 1
    fi
    echo "✓ $name matches pinned SHA: $actual"
  else
    echo "⚠️ $name .git not found at $dir; skipping local SHA check"
  fi
}

verify_sha "$TONALLI_CORE_ROOT" "$EXPECTED_CORE_SHA" "tonalli-core"
verify_sha "$TONALLI_AGENTS_ROOT" "$EXPECTED_AGENTS_SHA" "tonalli-agents"
verify_sha "$RMZ_WALLET_ROOT" "$EXPECTED_WALLET_SHA" "RMZWallet"

export TONALLI_AGENTS_ROOT
export RMZ_WALLET_ROOT

echo "Executing Phase C1 Cross-Repo Contract Tests..."
cd "$WORKSPACE_ROOT"
pnpm --filter @x402-xec/agent-bridge test

echo "=== [Phase C1 Cross-Repo Harness: ALL PASS] ==="
