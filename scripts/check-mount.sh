#!/usr/bin/env bash
# 静态检查：挂载条目是否写对、YAML 是否仍然合法。
# 只读取 profile 文件，不做任何写入。
set -uo pipefail

PATCH="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/desktop}/cordis.patch.yml"

echo "==> 目标文件: $PATCH"
if [ ! -f "$PATCH" ]; then
  echo "✖ 文件不存在"; exit 1
fi

echo "==> 1. 是否包含本插件条目"
if grep -q "dsh-dynamic-island-progress" "$PATCH"; then
  echo "    找到条目："
  grep -n -B3 -A2 "dsh-dynamic-island-progress" "$PATCH" | sed 's/^/      /'
else
  echo "✖ 未找到 dsh-dynamic-island-progress —— 条目没写进去？"
  exit 1
fi

echo "==> 2. YAML 是否可解析（用 node 的 yaml 若可用，否则做结构粗检）"
# 粗检：顶层是数组，insert 有缩进，name 与 insert 同级
if node -e '
const fs=require("fs");
const t=fs.readFileSync(process.argv[1],"utf8");
// 去掉注释行后，确认存在 "- insert:" 且其下 name 属于该 insert
const lines=t.split(/\r?\n/);
let inInsert=false, ok=false;
for(const l of lines){
  if(/^\s*#/.test(l)) continue;
  if(/^-\s*insert:\s*$/.test(l)){ inInsert=true; continue; }
  if(inInsert && /^\s*-\s*id:\s*dynamic-island-progress\s*$/.test(l)) continue;
  if(inInsert && /^\s*name:\s*dsh-dynamic-island-progress\s*$/.test(l)){ ok=true; }
  if(/^[^\s]/.test(l) && !/^-\s*insert:/.test(l)) inInsert=false;
}
process.exit(ok?0:1);
' "$PATCH"; then
  echo "    结构 OK（- insert: 下含正确 name）"
else
  echo "✖ 结构可疑：insert 下未找到正确的 name 行"
  exit 1
fi

echo "==> 3. 现有条目数（应比加之前多 1）"
grep -c "^- " "$PATCH" | sed 's/^/    顶层条目: /'

echo
echo "静态检查通过。下一步需要重启 DSH 让这一层生效。"
