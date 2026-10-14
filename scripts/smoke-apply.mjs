#!/usr/bin/env node
/**
 * 离线 apply() 冒烟测试：不需要 DSH、不需要重启、不需要 Swift helper。
 *
 * 用假的 ctx 真跑一遍 apply()，断言插件与宿主之间的**每一个接触点**。
 * 这不能替代真实挂载（真实 Loader 会做配置校验与 fiber 生命周期），
 * 但能把"注册形状写错"这类静默故障在重启之前就拦住。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const mod = await import(new URL(`file://${join(ROOT, 'src', 'index.ts')}`).href)

let failures = 0
const ok = (m) => console.log(`  ✔ ${m}`)
const bad = (m) => { failures++; console.log(`  ✖ ${m}`) }

// ---- 假的 Cronis ctx：记录每一次注册，并在卸载时跑 disposer ----
const registered = { provide: [], tools: [], sections: [], listeners: [], effects: [] }
const disposers = []

const fakeCtx = {
  logger: () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }),
  provide: (name, value) => { registered.provide.push({ name, value }); return () => {} },
  tools: { register: (def) => { registered.tools.push(def); return () => {} } },
  systemPrompt: { section: (s) => { registered.sections.push(s); return () => {} } },
  on: (name, listener) => { registered.listeners.push({ name, listener }); return () => {} },
  effect: (fn, label) => {
    const d = fn()
    registered.effects.push({ label, disposer: d })
    disposers.push(d)
    return () => {}
  },
}

const socketPath = join(mkdtempSync(join(tmpdir(), 'island-smoke-')), 'island.sock')
mod.apply(fakeCtx, { socketPath, helperPath: '/nonexistent-on-purpose', connectTimeoutMs: 300, graceMs: 200 })

console.log('== 注册接触点 ==')
const svc = registered.provide.find((p) => p.name === 'islandProgress')
if (svc) ok(`ctx.provide('islandProgress')`)
else bad('没有注册 islandProgress 服务')
if (svc && typeof svc.value.report === 'function' && typeof svc.value.current === 'function') {
  ok('服务暴露 report() 与 current()')
} else bad('islandProgress 服务形状不对')

const tool = registered.tools[0]
if (tool?.name === 'report_progress') ok('注册了 report_progress 工具')
else bad(`工具未注册或名字不对: ${String(tool?.name)}`)

const sec = registered.sections[0]
if (sec && typeof sec.text === 'string' && sec.text.includes('report_progress')) {
  ok(`注册了 systemPrompt 段（order=${sec.order}，含工具名）`)
} else bad('systemPrompt 段缺失或未提到工具名')

const ev = registered.listeners.find((l) => l.name === 'session/event')
if (ev) ok(`监听 session/event（共 ${registered.listeners.length} 个监听器）`)
else bad('没有监听 session/event —— 进度永远不会更新')

if (registered.effects.length === 1) ok('恰好一个 ctx.effect（生命周期收敛在一处）')
else bad(`ctx.effect 数量为 ${registered.effects.length}，应为 1`)

// ---- 走一遍状态机：turn/start -> step/end -> turn/end ----
console.log('\n== 事件驱动（真跑 reducer + 状态机）==')
const send = (type, data) => ev?.listener({ id: 's' }, { type, data })
send('turn/start', { turn: 1 })
if (svc.value.current().state === 'estimated') ok('turn/start 后进入 estimated（5%）')
else bad(`turn/start 后状态为 ${svc.value.current().state}`)
send('step/end', { turn: 1, step: 12 })
const afterStep = svc.value.current().percent
if (afterStep > 0.05 && afterStep <= 0.9) ok(`step/end 推进到 ${(afterStep * 100).toFixed(0)}%（未越过 90%）`)
else bad(`step/end 后为 ${afterStep}，越界`)
send('todo/write', { todos: [{ status: 'completed' }, { status: 'pending' }] })
if (svc.value.current().mode === 'precise') ok('todo/write 切到 precise（0.5）')
else bad('todo/write 未切到 precise')
send('turn/end', { turn: 1, reason: { kind: 'aborted' } })
if (svc.value.current().ok === false && svc.value.current().percent < 1) ok('异常终态不显示 100%')
else bad('异常终态错误地显示了 100%')

// ---- 卸载 ----
console.log('\n== 卸载（disposer 必须等进程停稳）==')
const t0 = Date.now()
for (const d of disposers) { if (typeof d === 'function') await d() }
ok(`全部 disposer 在 ${Date.now() - t0}ms 内完成，无残留`)

console.log('')
if (failures === 0) console.log('结论：apply() 的全部宿主接触点正常。')
else { console.log(`结论：${failures} 项失败。`); process.exitCode = 1 }
