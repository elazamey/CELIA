#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BRANCH_NAME="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'detached')"
mkdir -p .cache
printf '[%s] Archived worktree on branch %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$BRANCH_NAME" >> .cache/worktree-archive.log
echo "[CELIA × Orca] Worktree '$BRANCH_NAME' archived cleanly."
