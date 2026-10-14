#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export npm_config_cache="$PWD/.npm-cache"
export PNPM_HOME="$PWD/.pnpm-home"
PNPM="/Users/yueli/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs"
mkdir -p "$npm_config_cache" "$PNPM_HOME"
if [ -f "$PNPM" ]; then
  node "$PNPM" install --store-dir "$PWD/.pnpm-store"
else
  npm install
fi
