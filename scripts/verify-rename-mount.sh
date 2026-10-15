#!/usr/bin/env bash
# 校验本插件的 profile 挂载是否与仓库当前的包名一致。
#
# 只读取 profile 文件与 node_modules，不做任何写入。用于改名之后确认
# 「新条目已登记、符号链接指向本仓库、旧条目已清理」三件事都成立。
#
# 包名不写死在脚本里，而是从仓库的 package.json 读：本仓库改过一次名，而
# 硬编码的断言在改名后会静默失效——它会让**正确的挂载**判失败，或让陈旧的
# 挂载悄悄通过。这个脚本因此把「名字」当作输入，而不是当作常量。
set -uo pipefail

PROFILE="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/desktop}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

pass=0
fail=0
warn=0

ok()   { echo "  ✔ $1"; pass=$((pass + 1)); }
bad()  { echo "  ✘ $1"; fail=$((fail + 1)); }
warnf(){ echo "  ⚠ $1"; warn=$((warn + 1)); }
info() { echo "    $1"; }

PKG="$(node -e "console.log(require(process.argv[1]).name)" "$REPO/package.json" 2>/dev/null || true)"
if [ -z "$PKG" ]; then
  echo "✘ 读不出 $REPO/package.json 的 name" >&2
  exit 1
fi

echo "==> profile:    $PROFILE"
echo "==> 仓库:       $REPO"
echo "==> 当前包名:   $PKG"
echo

if [ ! -f "$PROFILE/package.json" ]; then
  echo "✘ 找不到 $PROFILE/package.json —— profile 目录不对？" >&2
  exit 1
fi

# 打印 profile 里所有「像本插件」的包名，供 3 处复用：
#   - 以 dsh- 开头且含 island   → 我们自己的命名空间，旧名一定长这样
#   - 或 dependencies 里是 link: 指向 $REPO 的键
candidates() {
  node -e '
const repo = process.argv[2];
const p = require(process.argv[1]);
const deps = p.dependencies || {};
const bundles = ((p.dsh && p.dsh.profile && p.dsh.profile.bundles) || []);
const names = new Set([...Object.keys(deps), ...bundles]);
for (const n of names) {
  const linked = typeof deps[n] === "string" && deps[n].includes(repo);
  const looksOurs = n.startsWith("dsh-") && n.includes("island");
  if (linked || looksOurs) console.log(n);
}
' "$PROFILE/package.json" "$REPO"
}

echo "==> 1. 依赖项（dependencies）"
if node -e "
const d=(require(process.argv[1]).dependencies)||{};
process.exit(Object.prototype.hasOwnProperty.call(d, process.argv[2]) ? 0 : 1);
" "$PROFILE/package.json" "$PKG"; then
  ok "dependencies 里有 $PKG"
  info "$(node -e "console.log(require(process.argv[1]).dependencies[process.argv[2]])" "$PROFILE/package.json" "$PKG")"
else
  bad "dependencies 里没有 $PKG —— 插件管理器里的「添加」还没做？"
fi

echo
echo "==> 2. bundle 列表（dsh.profile.bundles）"
# dependencies 决定 pnpm 装什么，bundles 决定这一层**会不会被应用**。
# 只在前者登记时，包能装上但什么都不会发生，且不报任何错。
if node -e "
const p=require(process.argv[1]);
const b=(p.dsh&&p.dsh.profile&&p.dsh.profile.bundles)||[];
process.exit(b.includes(process.argv[2]) ? 0 : 1);
" "$PROFILE/package.json" "$PKG"; then
  ok "bundles 里有 $PKG"
else
  bad "bundles 里没有 $PKG —— 层不会被应用"
fi

echo
echo "==> 3. node_modules 符号链接"
link="$PROFILE/node_modules/$PKG"
if [ -L "$link" ]; then
  target="$(readlink "$link")"
  absolute="$(cd "$(dirname "$link")" 2>/dev/null && cd "$(dirname "$target")" 2>/dev/null && pwd)/$(basename "$target")"
  ok "$PKG 是符号链接"
  info "-> $target"
  if [ "$absolute" = "$REPO" ]; then
    ok "指向本仓库（改动会立刻生效，无需重装）"
  else
    warnf "指向 ${absolute}，不是 $REPO —— 改动不会反映到这里"
  fi
elif [ -e "$link" ]; then
  warnf "$PKG 存在但不是符号链接（可能是拷贝安装）—— 改动需要重新安装才生效"
else
  bad "node_modules 里没有 $PKG"
fi

echo
echo "==> 4. 陈旧残留（指向本仓库的其它包名）"
stale=""
while IFS= read -r n; do
  [ -n "$n" ] || continue
  [ "$n" = "$PKG" ] && continue
  stale="$stale $n"
  bad "profile 里仍有旧包名 $n"
done < <(candidates)
if [ -z "$stale" ]; then
  ok "没有旧包名残留"
else
  info "在插件管理器里移除它们；旧符号链接若已无依赖引用也会一并消失"
fi

echo
echo "==> 5. bundle 的 patch 层是否指向当前包名"
patch="$link/cordis.patch.yml"
if [ -f "$patch" ]; then
  if grep -q "name: $PKG" "$patch"; then
    ok "cordis.patch.yml 的 name 是 $PKG"
  else
    bad "cordis.patch.yml 里没有 name: $PKG —— bundle 层会解析不到"
    sed 's/^/      /' "$patch"
  fi
else
  bad "找不到 $patch"
fi

echo
echo "==> 6. 插件是否真的加载了（apply() 写的标记）"
marker="$HOME/Library/Application Support/dsh-island/plugin-applied.json"
if [ -f "$marker" ]; then
  ok "存在 plugin-applied.json"
  info "$(node -e "const m=require(process.argv[1]);console.log('at='+m.at+'  pid='+m.pid)" "$marker")"
  info "换包名后 at 会更新；若仍是旧时间戳，说明插件尚未重新加载"
else
  bad "没有 plugin-applied.json —— 插件从未 apply()，问题在加载层"
fi

echo
echo "----------------------------------------"
echo "通过 $pass 项，失败 $fail 项，警告 $warn 项"
if [ "$fail" -gt 0 ]; then
  echo "结论：挂载与当前包名 $PKG 不一致。按 scripts/mount-patch.md 在插件管理器里操作。"
  exit 1
fi
echo "结论：挂载已切到 ${PKG}，且指向本仓库。"
