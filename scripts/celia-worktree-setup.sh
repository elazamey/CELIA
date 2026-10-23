#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "=== [CELIA × Orca] Preparing new worktree ==="
mkdir -p .cache .workspaces

if [[ ! -f .env && -f .env.example ]]; then
  cp .env.example .env
  echo "[setup] Created local .env from .env.example"
fi

node scripts/celia-orchestrator.mjs validate
echo "=== [CELIA × Orca] Worktree is ready ==="
