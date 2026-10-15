#!/usr/bin/env node
/**
 * 挂载自检：不需要重启 DSH 就能判断插件是否真的能被加载。
 *
 * 检查三件事：
 *   1. 绝对路径可加载、导出形状正确、没有 export default（那会丢弃 inject）
 *   2. profile 的 cordis.patch.yml 里条目写对
 *   3. 宿主日志里是否已出现本插件的降级提示（证明 apply() 真的跑过）
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const HOME = process.env.HOME
const PROFILE = process.env.DSH_PROFILE_DIR ?? join(HOME, '.dsh', 'profiles', 'desktop')
const PATCH = join(PROFILE, 'cordis.patch.yml')
const ENTRY = join(ROOT, 'src', 'index.ts')

// Read, never hardcode: this repo has been renamed twice, and a literal here
// silently asserts the OLD name — failing a correct mount, or passing a stale
// one. The package name is an input to this script, not a constant.
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name
const PKG_RE = new RegExp(`^\\s*name:\\s*${PKG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm')

let failures = 0
const ok = (m) => console.log(`  ✔ ${m}`)
const bad = (m) => { failures++; console.log(`  ✖ ${m}`) }

console.log('== 1. 插件入口能否被宿主加载 ==')
try {
  const m = await import(new URL(`file://${ENTRY}`).href)
  ok(`加载成功: ${ENTRY}`)
  // Compared against the package name rather than a literal: this repo has been
  // renamed twice, and a hardcoded identifier here turns a rename into a
  // false failure. `m.name` is the plugin's internal identifier; the loader
  // resolves the plugin by `package.json`'s `name`, so the check is that the two
  // have not drifted apart.
  if (m.name === PKG) ok(`name = ${m.name}`)
  else bad(`name 与包名不一致: 插件导出 ${String(m.name)}，package.json 是 ${PKG}`)
  const inj = m.inject ?? []
  if (inj.includes('tools') && inj.includes('systemPrompt')) ok(`inject = ${JSON.stringify(inj)}`)
  else bad(`inject 缺少必需服务: ${JSON.stringify(inj)}`)
  if (typeof m.apply === 'function') ok('apply 存在')
  else bad('apply 不是函数')
  if (m.default === undefined) ok('没有 export default（否则 inject 会被静默丢弃）')
  else bad('检测到 export default —— 会导致 inject/name/Config 全部丢失')
} catch (e) {
  bad(`加载失败: ${e.code ?? ''} ${(e.message ?? '').split('\n')[0]}`)
}

console.log('\n== 2. profile 是否登记为 bundle ==')
// A bundle is applied via TWO independent registrations, and checking only one
// of them gives a confidently wrong answer:
//   - `dependencies`      → what pnpm installs into the profile's node_modules
//   - `dsh.profile.bundles` → what makes the layer get APPLIED
// A package listed only in the former installs cleanly and then does nothing,
// with no error anywhere.
//
// The profile's own `cordis.patch.yml` is NOT where this belongs: a bundle's
// patch comes from inside the package (`package.json` → `dsh.bundle.patch`),
// so this script used to demand `id: dynamic-island` in a file that is only
// meant for user overrides — failing a perfectly good install.
const profilePkg = join(PROFILE, 'package.json')
if (!existsSync(profilePkg)) {
  bad(`找不到 ${profilePkg}`)
} else {
  const p = JSON.parse(readFileSync(profilePkg, 'utf8'))
  const deps = p.dependencies ?? {}
  const bundles = p.dsh?.profile?.bundles ?? []

  if (Object.prototype.hasOwnProperty.call(deps, PKG)) {
    ok(`dependencies 里登记了 ${PKG}`)
    const spec = String(deps[PKG])
    const installed = join(PROFILE, 'node_modules', PKG)
    if (spec.startsWith('link:') || spec.startsWith('file:')) {
      ok('是本地链接安装 —— 仓库改动会立刻生效')
    } else if (existsSync(installed)) {
      // Distinguish the two, because the difference decides whether editing the
      // repo changes anything: an npm install is a frozen copy.
      ok(`按版本安装（${spec}）—— 注意：这是已发布的快照，仓库改动不会生效`)
    } else {
      bad(`dependencies 里有 ${PKG}，但 node_modules 下没有它 —— 需要重新安装`)
    }
  } else {
    bad(`dependencies 里没有 ${PKG} —— 插件管理器里的「添加」还没做？`)
  }

  if (bundles.includes(PKG)) ok(`dsh.profile.bundles 里登记了 ${PKG}（层会被应用）`)
  else bad(`dsh.profile.bundles 里没有 ${PKG} —— 包会装上但这一层不会被应用`)

  for (const key of Object.keys(deps)) {
    if (key !== PKG && key.startsWith('dsh-') && key.includes('island')) {
      bad(`dependencies 里仍有旧包名 ${key} —— 建议在插件管理器里移除`)
    }
  }
}

// Optional overrides DO live in the profile patch. Reported, never required.
if (existsSync(PATCH)) {
  const text = readFileSync(PATCH, 'utf8')
  const usesBareName = PKG_RE.test(text)
  const usesPath = text.includes(ENTRY)
  if (usesPath) ok('profile patch 用绝对路径覆盖（可解析）')
  else if (usesBareName) {
    bad('profile patch 用裸包名覆盖，但它没安装进 profile 的 node_modules —— 该行会被静默丢弃')
    console.log(`     改成绝对路径：`)
    console.log(`       name: "${ENTRY}"`)
  }
}

console.log('\n== 3. 宿主日志里是否已出现本插件的提示 ==')
const sessRoot = join(HOME, '.dsh', 'sessions')
let found = null
try {
  const dirs = readdirSync(sessRoot).map((d) => join(sessRoot, d))
  for (const d of dirs.slice(-40)) {
    try {
      if (!statSync(d).isDirectory()) continue
      for (const f of readdirSync(d)) {
        if (!/\.(jsonl|log|json)$/.test(f)) continue
        const p = join(d, f)
        if (statSync(p).size > 8_000_000) continue
        const t = readFileSync(p, 'utf8')
        if (t.includes('island: helper not reachable') || t.includes('island helper:')) { found = p; break }
      }
    } catch { /* skip */ }
    if (found) break
  }
} catch { /* skip */ }
if (found) ok(`apply() 已经跑过（${found}）`)
else console.log('  · 没找到本插件的日志。若尚未重启 DSH，这是正常的。')

console.log('')
if (failures === 0) {
  console.log('结论：入口可用。重启 DSH 后应能在日志看到：')
  console.log('  island: helper not reachable at ... —— 这是预期的（Swift helper 还没构建）')
} else {
  console.log(`结论：有 ${failures} 项需要处理，见上方 ✖。`)
  process.exitCode = 1
}
