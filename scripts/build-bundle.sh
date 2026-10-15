#!/usr/bin/env bash
# Build everything the published bundle needs. This is what `prepack` runs, so it
# is also what `pnpm publish` and `pnpm pack` run.
#
# Two artifacts, for two different reasons:
#
#  1. lib/*.js — Node refuses to strip TypeScript types for files under
#     `node_modules` (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so a bundle
#     whose `main` points at `src/index.ts` imports fine from a linked checkout and
#     fails with "failed to import" once installed. Shipping built JS is the only
#     thing that works for other people.
#  2. bin/DynamicIslandBridge — the native helper, universal so it runs on Intel
#     Macs too.
#
# Both are git-ignored build outputs; neither is committed.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> 1/2 编译 TypeScript → lib/"
if [ ! -x ./node_modules/.bin/tsc ]; then
  echo "✖ 找不到本地 tsc。先运行：bash scripts/install-deps.sh" >&2
  exit 1
fi
rm -rf lib
./node_modules/.bin/tsc -p tsconfig.build.json

# `main` is what the loader imports; if the build emitted nothing there, the
# package installs and then silently fails to activate.
MAIN="$(node -e "console.log(require('./package.json').main)")"
if [ ! -f "$MAIN" ]; then
  echo "✖ package.json 的 main 指向 $MAIN，但构建没有产出它" >&2
  exit 1
fi
if grep -rqE "from ['\"]\.[^'\"]*\.ts['\"]" lib/; then
  echo "✖ 产出的 JS 里仍有指向 .ts 的 import —— 安装后解析不到（rewriteRelativeImportExtensions 没生效？）" >&2
  grep -rnE "from ['\"]\.[^'\"]*\.ts['\"]" lib/ | head -5 >&2
  exit 1
fi
echo "    $MAIN ($(find lib -name '*.js' | wc -l | tr -d ' ') 个模块)"

echo "==> 2/2 构建原生 helper"
bash scripts/build-helper.sh
