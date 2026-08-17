#!/usr/bin/env bash
# local-ci.sh — Unix/macOS entry point for the Bonk-RL-Env local CI engine.
# Forwards every argument to scripts/local-ci.ts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

exec npx tsx scripts/local-ci.ts "$@"
