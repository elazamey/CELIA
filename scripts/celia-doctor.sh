#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "=================================================="
echo "  CELIA × Orca — Ecosystem & Integration Doctor   "
echo "=================================================="
echo "Node.js : $(node -v)"
echo "Git     : $(git --version)"
echo "Branch  : $(git rev-parse --abbrev-ref HEAD)"
echo ""

bash scripts/orca-sync.sh status
echo ""

node scripts/celia-orchestrator.mjs validate
echo ""
echo "Doctor status: HEALTHY"
