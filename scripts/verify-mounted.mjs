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
  if (m.name === 'dynamic-island-progress') ok(`name = ${m.name}`)
  else bad(`name 异常: ${String(m.name)}`)
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

console.log('\n== 2. profile 挂载条目 ==')
if (!existsSync(PATCH)) {
  bad(`找不到 ${PATCH}`)
} else {
  const text = readFileSync(PATCH, 'utf8')
  // The layer id is what the bundle's own cordis.patch.yml inserts with; the
  // package name is what a `name:`-style entry would use. Accept either, since
  // both are observed in the wild depending on how the plugin was mounted.
  if (!text.includes('dynamic-island') && !text.includes(PKG)) bad('patch 里没有本插件条目')
  else ok('patch 里有本插件条目')
  const usesBareName = PKG_RE.test(text)
  const usesPath = text.includes(ENTRY)
  if (usesPath) ok('使用绝对路径引用（可解析）')
  else if (usesBareName) {
    bad('使用裸包名，但它没有安装进 profile 的 node_modules —— 这一层会加载失败')
    console.log(`     改成绝对路径即可：`)
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
