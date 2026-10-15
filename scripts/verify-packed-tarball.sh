#!/usr/bin/env bash
# Prove the *packaged artifact* installs and activates for someone else.
#
# Everything else in this repo tests the checkout. This script tests what a
# stranger actually receives: it packs the tarball the way `pnpm publish` would,
# asserts the tarball carries the pieces the bundle needs, installs it into a
# throwaway profile through the documented CLI path, and asks the launcher whether
# the resulting layer contains our plugin row.
#
# It deliberately does NOT use the desktop profile: that one is managed by the
# Electron app and `dsh` refuses to touch it. A scratch profile is also the more
# honest test — it has never seen this plugin before.
#
# Usage: scripts/verify-packed-tarball.sh [--profile NAME] [--boot] [--keep]
#   --boot   additionally start the scratch profile once, which is what proves the
#            installed module actually *loads* (composition alone does not)
#   --keep   leave the scratch profile behind for inspection
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE="island-test"
BOOT=0
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:?--profile 需要一个名字}"; shift 2 ;;
    --boot) BOOT=1; shift ;;
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "✖ 未知参数：$1" >&2; exit 1 ;;
  esac
done

# `dsh` is often not on PATH for a non-interactive shell (the desktop app ships its
# own launcher). Fall back to the app bundle's copy so this script works either way.
DSH_BIN="${DSH_BIN:-$(command -v dsh || true)}"
if [ -z "$DSH_BIN" ]; then
  DSH_BIN="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
fi
[ -x "$DSH_BIN" ] || { echo "✖ 找不到 dsh 可执行文件；用 DSH_BIN=/path/to/dsh 指定" >&2; exit 1; }

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
MARKER="$HOME/Library/Application Support/dsh-island/plugin-applied.json"

# pnpm, likewise, may only exist inside the dsh runtime.
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
PNPM_BIN="${PNPM_BIN:-$(command -v pnpm || true)}"
if [ -z "$PNPM_BIN" ]; then
  PNPM_BIN="$DSH_HOME/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs"
  [ -n "$NODE_BIN" ] || NODE_BIN="$DSH_HOME/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"
fi
export npm_config_cache="$PWD/.npm-cache"

fail() { echo; echo "✖ $*" >&2; exit 1; }
ok() { echo "  ✔ $*"; }

echo "dsh    : $DSH_BIN ($("$DSH_BIN" --version 2>/dev/null || echo '?'))"
echo "profile: $PROFILE_DIR"
echo

# ---- 1. pack exactly like a publish would ------------------------------------
echo "==> 1/5 pnpm pack（会触发 prepack，构建 universal helper）"
rm -f ./*.tgz
# pnpm echoes the prepack script on stdout, so the last line is not reliably the
# artifact name — discover the file instead of parsing output.
if [ -n "$NODE_BIN" ]; then
  "$NODE_BIN" "$PNPM_BIN" pack --pack-destination . >/tmp/island-pack.log 2>&1 || { tail -20 /tmp/island-pack.log; fail "pnpm pack 失败"; }
else
  "$PNPM_BIN" pack --pack-destination . >/tmp/island-pack.log 2>&1 || { tail -20 /tmp/island-pack.log; fail "pnpm pack 失败"; }
fi
TARBALL="$(ls -t ./*.tgz 2>/dev/null | head -1)"
[ -n "$TARBALL" ] && [ -f "$TARBALL" ] || fail "pnpm pack 没有产出 tarball"
ok "产出 ${TARBALL}（$(( $(stat -f%z "$TARBALL") / 1024 )) KiB）"

# ---- 2. the tarball must carry everything the bundle needs -------------------
echo
echo "==> 2/5 检查 tarball 内容"
LIST="$(tar -tzf "$TARBALL")"
for wanted in package/package.json package/cordis.patch.yml package/src/index.ts package/bin/DynamicIslandBridge; do
  grep -qx "$wanted" <<<"$LIST" || fail "tarball 里缺少 $wanted"
done

# `main` must point at built JavaScript. Node refuses to strip types under
# node_modules, so a `.ts` entry imports fine from a linked checkout and fails with
# "failed to import" the moment the package is installed — which is exactly how the
# first packaged build behaved.
MAIN_ENTRY="$(tar -xzOf "$TARBALL" package/package.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).main))")"
case "$MAIN_ENTRY" in
  *.ts) fail "package.json 的 main 指向 $MAIN_ENTRY —— 装到 node_modules 下会 import 失败" ;;
esac
grep -qx "package/$MAIN_ENTRY" <<<"$LIST" || fail "tarball 里没有 main 指向的 $MAIN_ENTRY"
ok "cordis.patch.yml、bin/DynamicIslandBridge、以及 main → $MAIN_ENTRY 都在"

# The helper has to be a runnable universal binary: a native-only or wrong-target
# build installs fine and then fails on the user's machine.
EXTRACT="$(mktemp -d)"
tar -xzf "$TARBALL" -C "$EXTRACT"
HELPER="$EXTRACT/package/bin/DynamicIslandBridge"

# `pnpm pack` (unlike `npm pack`) writes the binary as 0644. That is not fatal —
# the plugin restores the bit before spawning, pinned by the helper test
# "helper 缺少可执行位时（pnpm pack 会丢掉它）插件在 spawn 前补回来" — but record it,
# because if the plugin ever stops doing that, every tarball install breaks with
# "helper not reachable" and nothing else would point at the cause.
MODE="$(stat -f '%Sp' "$HELPER")"
echo "  ·  tarball 里的权限位：${MODE}（pnpm 不保留可执行位；插件在 spawn 前补）"
chmod +x "$HELPER"

ARCHS="$(lipo -archs "$HELPER")"
case "$ARCHS" in
  *arm64*x86_64*|*x86_64*arm64*) ok "helper 是 universal：$ARCHS" ;;
  *) fail "helper 只含 $ARCHS —— Intel Mac 装上去会直接失败" ;;
esac

for arch in $ARCHS; do
  minos="$(vtool -arch "$arch" -show-build "$HELPER" | awk '/minos/ {print $2; exit}')"
  [ "$minos" = "13.0" ] || fail "$arch 的 minos 是 ${minos}，期望 13.0"
done
ok "两个 slice 的 minos 都是 13.0"

# A packaged helper that cannot even print its version is the failure mode the
# end-to-end check hit once (a sidecar resource bundle missing from the package).
"$HELPER" --version >/dev/null || fail "包里的 helper 无法运行（--version 失败）"
ok "包里的 helper 能运行"

BUNDLE_SIDECARS="$(grep -c 'package/bin/.*\.bundle/' <<<"$LIST" || true)"
if [ "$BUNDLE_SIDECARS" != "0" ]; then
  fail "tarball 里带了 SwiftPM 资源 bundle —— helper 应当自包含（见 WhaleMarkData.swift）"
fi
ok "helper 是自包含的单个文件"

# ---- 3. install into a scratch profile ---------------------------------------
echo
echo "==> 3/5 安装进一次性 profile"
if [ -e "$PROFILE_DIR" ]; then
  fail "$PROFILE_DIR 已存在。这是本脚本的一次性 profile，请先删除或换 --profile 名字。"
fi

"$DSH_BIN" plugin --profile "$PROFILE" add "./$TARBALL" >/tmp/island-pack-install.log 2>&1 \
  || { tail -25 /tmp/island-pack-install.log; fail "安装失败（完整日志：/tmp/island-pack-install.log）"; }
ok "装好了"

grep -q "$(node -e "console.log(require('./package.json').name)")" "$PROFILE_DIR/package.json" \
  || fail "profile 的 package.json 里没登记这个包"
ok "profile 的 dependencies 里登记了它"

grep -q "dynamic-island-progress" "$PROFILE_DIR/package.json" \
  || fail "profile 的 dsh.profile.bundles 里没有它 —— 层不会被应用"
ok "dsh.profile.bundles 里登记了它"

# ---- 4. the layer must show up in the composed config ------------------------
echo
echo "==> 4/5 该层是否进入合成配置"
if "$DSH_BIN" --profile "$PROFILE" --dump-config 2>&1 | grep -qi "dynamic-island"; then
  ok "合成配置里出现了 dynamic-island"
else
  "$DSH_BIN" --profile "$PROFILE" --dump-config 2>&1 | head -5
  fail "合成配置里没有我们的层"
fi

# ---- 5. (optional) boot it, which is what proves the module loads ------------
if [ "$BOOT" -eq 1 ]; then
  echo
  echo "==> 5/5 启动一次，验证模块真的被加载"
  echo "    判据是插件自己写的加载标记：apply() 的第一件事就是写它。"
  rm -f "$MARKER"
  # headless 是能真正 mount 插件里最便宜的方式。等的是**标记文件出现**这个条件，
  # 而不是进程退出：这个一次性 profile 没有配模型，headless 可能一直挂着，而我们要
  # 的证据（apply() 写的标记）在它挂住之前就已经落盘了。
  "$DSH_BIN" --profile "$PROFILE" headless "只回复两个字：收到" </dev/null >/tmp/island-pack-boot.log 2>&1 &
  BOOT_PID=$!
  for _ in $(seq 1 60); do
    [ -f "$MARKER" ] && break
    kill -0 "$BOOT_PID" 2>/dev/null || break
    sleep 1
  done
  kill -TERM "$BOOT_PID" 2>/dev/null || true
  wait "$BOOT_PID" 2>/dev/null || true

  if grep -qE "did not activate|failed to import" /tmp/island-pack-boot.log; then
    grep -E "did not activate|failed to import" /tmp/island-pack-boot.log >&2
    fail "launcher 报告该行没有激活（上面的原话）"
  fi

  if [ -f "$MARKER" ]; then
    ok "加载标记已写出：$(tr -d '\n' < "$MARKER")"
    if grep -q "$PROFILE" "$MARKER"; then
      ok "标记里的 helperPath 指向这个一次性 profile 的安装副本 —— 装进来的那份确实加载了"
    else
      fail "标记存在但不指向这个 profile，无法证明是这份安装被加载"
    fi
  else
    tail -20 /tmp/island-pack-boot.log
    fail "启动后没有加载标记 —— 包能装但模块没被加载（多半是 main 指向的 .ts 没被 loader 处理）"
  fi
else
  echo
  echo "==> 5/5 跳过启动验证（加 --boot 才会真正 mount 插件）"
fi

# ---- cleanup -----------------------------------------------------------------
if [ "$KEEP" -eq 1 ]; then
  echo
  echo "保留一次性 profile：$PROFILE_DIR"
else
  # Guard the destructive step: only ever remove the profile we created here.
  case "$PROFILE_DIR" in
    "$DSH_HOME"/profiles/*) rm -rf "$PROFILE_DIR"; echo; echo "已删除一次性 profile：$PROFILE_DIR" ;;
    *) fail "拒绝删除不在 $DSH_HOME/profiles 下的路径：$PROFILE_DIR" ;;
  esac
fi
rm -rf "$EXTRACT" "$TARBALL"

echo
echo "结论：打包产物可被陌生人按文档路径安装并激活。"
