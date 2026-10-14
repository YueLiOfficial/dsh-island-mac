#!/usr/bin/env bash
# Prove the plugin's teardown reaches quiescence: no helper process survives.
#
# This is the only check that validates the cleanup contract. A passing unit
# suite with a live orphan is still a broken plugin.
set -uo pipefail
cd "$(dirname "$0")/.."

MARKER="${1:-fake-helper.mjs}"

echo "==> 运行 helper 测试（其 dispose 应终止所有子进程）"
if ! node --test test/helper.test.ts >/tmp/island-teardown-test.log 2>&1; then
  echo "✖ 测试本身失败；先修复测试再谈清理"
  tail -20 /tmp/island-teardown-test.log
  exit 1
fi
echo "    测试通过"

# Give an in-flight SIGTERM a moment to take effect before judging.
sleep 0.2

echo "==> 检查进程表中是否有遗留的辅助进程（匹配: ${MARKER}）"
if pgrep -fl "$MARKER" 2>/dev/null; then
  echo
  echo "✖ 发现孤儿进程。dispose 未达到完全停稳——这是阻塞性缺陷。"
  echo "  用 ps -o pid,ppid,command -p <PID> 确认归属后再清理："
  echo "    pkill -f $MARKER"
  exit 1
fi

echo "CLEAN: 无孤儿进程"
exit 0
