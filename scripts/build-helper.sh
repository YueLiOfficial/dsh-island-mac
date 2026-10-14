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

echo "==> swift build -c release"
swift build -c release --disable-sandbox --package-path "$PACKAGE"

BUILT="$(swift build -c release --disable-sandbox --package-path "$PACKAGE" --show-bin-path)/DynamicIslandBridge"
if [ ! -x "$BUILT" ]; then
  echo "✖ 构建完成但未找到可执行文件：$BUILT" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
cp "$BUILT" "$OUT"
chmod +x "$OUT"
echo "==> 已安装到 $OUT"
"$OUT" --version 2>/dev/null || true
