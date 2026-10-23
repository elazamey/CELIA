#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ACTION="${1:-status}"

resolve_orca_cli() {
  if [[ -n "${ORCA_CLI_COMMAND:-}" ]]; then
    echo "$ORCA_CLI_COMMAND"
  elif [[ -n "${ORCA_DEV_REPO_ROOT:-}" ]] && command -v orca-dev >/dev/null 2>&1; then
    echo "orca-dev"
  elif [[ "$(uname -s)" == "Linux" ]]; then
    if command -v orca-ide >/dev/null 2>&1; then
      echo "orca-ide"
    else
      echo ""
    fi
  elif command -v orca >/dev/null 2>&1; then
    echo "orca"
  else
    echo ""
  fi
}

case "$ACTION" in
  status)
    echo "=== CELIA × Orca Submodule Status ==="
    git submodule status orca || true
    echo "Configured URL: $(git config -f .gitmodules submodule.orca.url)"
    ORCA_BIN="$(resolve_orca_cli)"
    if [[ -n "$ORCA_BIN" ]]; then
      echo "Detected Orca CLI: $ORCA_BIN"
    else
      echo "Detected Orca CLI: (not installed on this host — install from https://onorca.dev/download or build ./orca)"
    fi
    if [[ -f "orca/package.json" ]]; then
      echo "Local ./orca checkout: INITIALIZED"
    else
      echo "Local ./orca checkout: LINKED (lightweight gitlink; run 'bash scripts/orca-sync.sh init' to fetch source)"
    fi
    ;;

  init)
    echo "Fetching stablyai/orca shallowly (--depth 1) into ./orca ..."
    git submodule update --init --depth 1 orca
    echo "Done! ./orca is ready."
    ;;

  update)
    echo "Updating ./orca submodule to latest upstream main (--depth 1) ..."
    git submodule update --init --remote --depth 1 orca
    git status --short orca .gitmodules
    ;;

  install-skills)
    ORCA_BIN="$(resolve_orca_cli)"
    SKILLS=("orca-cli" "orchestration" "computer-use" "orca-linear" "orca-per-workspace-env")
    if [[ -n "$ORCA_BIN" ]]; then
      echo "Installing Orca skills via $ORCA_BIN ..."
      "$ORCA_BIN" skills install \
        --skill orca-cli \
        --skill orchestration \
        --skill computer-use \
        --skill orca-linear \
        --skill orca-per-workspace-env
    else
      echo "Orca CLI not found locally; installing skills via npx skills ..."
      for skill in "${SKILLS[@]}"; do
        npx --yes skills add https://github.com/stablyai/orca --skill "$skill" --global
      done
    fi
    ;;

  sync-services)
    mkdir -p .workspaces
    REPOS=(
      "ELAZAMEY"
      "celia-fashion-live"
      "celia.assestent"
      "celia_dreams"
      "nexa"
    )
    for repo in "${REPOS[@]}"; do
      target=".workspaces/$repo"
      if [[ -d "$target/.git" ]]; then
        echo "[update] $target"
        git -C "$target" pull --ff-only || true
      else
        echo "[clone] https://github.com/elazamey/$repo.git -> $target"
        git clone --depth 1 "https://github.com/elazamey/$repo.git" "$target"
      fi
    done
    echo "All CELIA companion repositories are synced under .workspaces/"
    ;;

  *)
    echo "Usage: bash scripts/orca-sync.sh [status|init|update|install-skills|sync-services]"
    exit 1
    ;;
esac
