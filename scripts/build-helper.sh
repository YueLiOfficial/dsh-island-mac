#!/usr/bin/env bash
# Build the Swift helper into bin/DynamicIslandBridge.
#
# Three toolchain facts this script exists to encode (all verified on this
# machine; see the Swift plan for the full write-up):
#
#  1. DynamicNotchKit is a SwiftUI package and needs the SwiftUIMacros plugin,
#     which ships ONLY inside Xcode.app. Command Line Tools cannot build it.
#  2. Inside the DSH agent sandbox, SwiftPM's manifest compilation is blocked by
#     `sandbox-exec`, so --disable-sandbox is required. It is harmless outside.
#  3. SwiftPM writes caches under $HOME, which may be read-only in a sandbox;
#     redirect them into the repository.
#
# Unlike the TS side, building this needs SwiftPM — do NOT try to validate the
# macros with a bare `swiftc` invocation. SwiftPM passes each macro plugin via
# an explicit -load-resolved-plugin path, which is why it works where a bare
# swiftc call cannot reach the plugin server.
set -euo pipefail
cd "$(dirname "$0")/.."

PACKAGE="swift/DynamicIslandBridge"
OUT="bin/DynamicIslandBridge"

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

echo "==> swift build -c release"
swift build -c release --disable-sandbox --package-path "$PACKAGE" "${SWIFTPM_CACHE_ARGS[@]}"

BUILT="$(swift build -c release --disable-sandbox --package-path "$PACKAGE" "${SWIFTPM_CACHE_ARGS[@]}" --show-bin-path)/DynamicIslandBridge"
if [ ! -x "$BUILT" ]; then
  echo "✖ 构建完成但未找到可执行文件：$BUILT" >&2
  exit 1
fi

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
echo "==> 已安装到 $OUT"

# Real check, not `|| true`: a helper that cannot print its version is a helper
# that will not start, and the plugin manager would report it as unreachable.
if ! "$OUT" --version; then
  echo "✖ $OUT 无法运行（--version 失败）。" >&2
  echo "  如果上面是 'Killed: 9'，多半还有旧 helper 进程占着这个路径：" >&2
  echo "    lsof -t \"$OUT\" | xargs -r kill -9" >&2
  exit 1
fi
