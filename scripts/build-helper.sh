#!/usr/bin/env bash
# Build the Swift helper into bin/DynamicIslandBridge.
#
# Builds BOTH architectures by default: the artifact this produces is what gets
# packaged and handed to other people, so "I forgot the universal flag" must not be
# a way to ship an Apple-Silicon-only plugin. Pass --native for a fast local loop.
#
# Four toolchain facts this script exists to encode (all verified on this
# machine; see the Swift plan for the full write-up):
#
#  1. DynamicNotchKit is a SwiftUI package and needs the SwiftUIMacros plugin,
#     which ships ONLY inside Xcode.app. Command Line Tools cannot build it.
#  2. Inside the DSH agent sandbox, SwiftPM's manifest compilation is blocked by
#     `sandbox-exec`, so --disable-sandbox is required. It is harmless outside.
#  3. SwiftPM writes caches under $HOME, which may be read-only in a sandbox;
#     redirect them into the repository.
#  4. The install must be a rename, not a copy over the destination — see the
#     comment at the install step.
#
# Unlike the TS side, building this needs SwiftPM — do NOT try to validate the
# macros with a bare `swiftc` invocation. SwiftPM passes each macro plugin via
# an explicit -load-resolved-plugin path, which is why it works where a bare
# swiftc call cannot reach the plugin server.
set -euo pipefail
cd "$(dirname "$0")/.."

PACKAGE="swift/DynamicIslandBridge"
OUT="bin/DynamicIslandBridge"
MINIMUM_MACOS="13.0"

UNIVERSAL=1
for argument in "$@"; do
  case "$argument" in
    --native) UNIVERSAL=0 ;;
    --universal) UNIVERSAL=1 ;;
    -h|--help)
      echo "用法: $(basename "$0") [--native|--universal]"
      echo "  --universal  arm64 + x86_64（默认，发布用）"
      echo "  --native     只编译本机架构（本地迭代更快）"
      exit 0
      ;;
    *)
      echo "✖ 未知参数：$argument" >&2
      exit 1
      ;;
  esac
done

if [ ! -d "$PACKAGE" ]; then
  echo "✖ 未找到 Swift 包：$PACKAGE" >&2
  echo "  Swift 侧尚未实现（见 Swift 计划）。" >&2
  exit 1
fi

# Prefer full Xcode when xcode-select still points at Command Line Tools.
if [ -d /Applications/Xcode.app/Contents/Developer ]; then
  export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
fi

if [ ! -d "${DEVELOPER_DIR:-/Library/Developer/CommandLineTools}/Platforms/MacOSX.platform/Developer/usr/lib/swift/host/plugins" ]; then
  echo "✖ 未找到 macOS 平台宏插件目录。" >&2
  echo "  需要完整 Xcode：sudo xcode-select -s /Applications/Xcode.app/Contents/Developer" >&2
  exit 1
fi

MACRO_PLUGIN="${DEVELOPER_DIR}/Platforms/MacOSX.platform/Developer/usr/lib/swift/host/plugins/libSwiftUIMacros.dylib"
if [ ! -f "$MACRO_PLUGIN" ]; then
  echo "✖ 缺少 libSwiftUIMacros.dylib —— SwiftUI 宏不可用，构建必然失败。" >&2
  echo "  预期位置：$MACRO_PLUGIN" >&2
  exit 1
fi

export CLANG_MODULE_CACHE_PATH="$PWD/.swift-cache"
export SWIFT_MODULECACHE_PATH="$PWD/.swift-cache"
mkdir -p "$CLANG_MODULE_CACHE_PATH"

# SwiftPM's own caches live under $HOME, which a DSH agent sandbox cannot write:
# it then prints three "not accessible or not writable" warnings on every
# invocation. Point them into the repository so build output stays clean.
SWIFTPM_CACHE_ARGS=(
  --cache-path "$PWD/.swift-cache/shared"
  --config-path "$PWD/.swift-cache/config"
  --security-path "$PWD/.swift-cache/security"
)

ARCH_ARGS=()
ARCH_LABEL="native"
if [ "$UNIVERSAL" -eq 1 ]; then
  ARCH_ARGS=(--arch arm64 --arch x86_64)
  ARCH_LABEL="arm64+x86_64"
fi

echo "==> swift build -c release ($ARCH_LABEL)"
swift build -c release --disable-sandbox --package-path "$PACKAGE" \
  "${ARCH_ARGS[@]}" "${SWIFTPM_CACHE_ARGS[@]}"

BUILT="$(swift build -c release --disable-sandbox --package-path "$PACKAGE" \
  "${ARCH_ARGS[@]}" "${SWIFTPM_CACHE_ARGS[@]}" --show-bin-path)/DynamicIslandBridge"
if [ ! -x "$BUILT" ]; then
  echo "✖ 构建完成但未找到可执行文件：$BUILT" >&2
  exit 1
fi

# Verify what was built before installing it, so a wrong-architecture or
# wrong-deployment-target artifact can never reach bin/ unnoticed.
SLICES="$(lipo -archs "$BUILT" 2>/dev/null || echo unknown)"
echo "==> 架构: $SLICES"
if [ "$UNIVERSAL" -eq 1 ]; then
  case "$SLICES" in
    *arm64*x86_64*|*x86_64*arm64*) ;;
    *)
      echo "✖ 期望 universal 二进制（arm64 + x86_64），实际：$SLICES" >&2
      exit 1
      ;;
  esac
fi

for arch in $SLICES; do
  minos="$(vtool -arch "$arch" -show-build "$BUILT" 2>/dev/null | awk '/minos/ {print $2; exit}')"
  if [ -z "${minos}" ]; then
    echo "✖ 读不出 $arch 的 minos（最低 macOS 版本）" >&2
    exit 1
  fi
  if [ "${minos}" != "${MINIMUM_MACOS}" ]; then
    echo "✖ $arch 的 minos 是 ${minos}，期望 ${MINIMUM_MACOS}（Package.swift 的 platforms）" >&2
    echo "  比预期更高的 minos 会让旧 macOS 直接拒绝启动这个 helper。" >&2
    exit 1
  fi
  echo "==> $arch minos: ${minos}"
done

mkdir -p "$(dirname "$OUT")"

# Install by rename, never by writing over the destination in place.
#
# `cp` onto a path that is currently some running helper's executable leaves the
# old process holding a vnode whose contents changed underneath it, and macOS then
# kills the *next* process that execs that path (observed as `Killed: 9`, with the
# file itself byte-identical to the build output and its signature valid). That
# failure looks exactly like a broken plugin, so the rename is not cosmetic.
STAGED="$OUT.staged.$$"
cp "$BUILT" "$STAGED"
chmod +x "$STAGED"
mv -f "$STAGED" "$OUT"

# Re-sign explicitly. What `ld` leaves behind is MARKED `linker-signed` but is NOT
# accepted by taskgated at exec time on this macOS: every fresh spawn died in
# ~16ms with `CODESIGNING / Taskgated Invalid Signature` +
# `SIGKILL (Code Signature Invalid)`, while `codesign --verify` reported "code
# object is not signed at all" even though an adhoc CodeDirectory was present.
#
# The failure is invisible at build time and only surfaces LATER, when a restart
# is attempted — which is exactly the "plugin looks dead but the process is still
# alive" symptom. `codesign --force --sign -` rewrites the CodeDirectory and adds
# the CMS slot the linker omitted; verified to turn "not signed at all" into
# "valid on disk / satisfies its Designated Requirement".
#
# Runs AFTER the rename so the signed bytes are the installed bytes.
#
# NOT the `cp`-over-a-running-binary trap documented above: that one also
# surfaces as `Killed: 9`, but the file verifies fine and only the *next* exec is
# killed. Same symptom, different cause; only this step addresses this one.
echo "==> 重新 ad-hoc 签名（否则 taskgated 会在 exec 时杀掉 helper）"
codesign --force --sign - --timestamp=none "$OUT"
codesign --verify --verbose=1 "$OUT"
echo "==> 已安装到 $OUT"

# Real check, not `|| true`: a helper that cannot print its version is a helper
# that will not start, and the plugin manager would report it as unreachable.
if ! "$OUT" --version; then
  echo "✖ $OUT 无法运行（--version 失败）。" >&2
  echo "  如果上面是 'Killed: 9'，多半还有旧 helper 进程占着这个路径：" >&2
  echo "    lsof -t \"$OUT\" | xargs -r kill -9" >&2
  exit 1
fi
