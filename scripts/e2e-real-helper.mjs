#!/usr/bin/env node
/**
 * 端到端：真插件源码 → 真 Swift helper 二进制 → 真窗口。
 *
 * 阶段一的 `smoke-apply.mjs` 用假 ctx 跑 apply()，`helper.test.ts` 用假 helper
 * （Node 写的 NDJSON server）验证生命周期。两者都**没有**碰过真二进制。
 * 本脚本补上那一步，覆盖完整链路：
 *
 *   session/event → 状态机 → Unix socket → Swift helper → 窗口服务器
 *
 * 并且刻意**不做**下面这种同义反复的检查：
 *
 *     node --test test/helper.test.ts && pgrep -f DynamicIslandBridge
 *
 * 那条命令里跑的是假 helper，`pgrep` 找不到真 helper 是必然的；更糟的是
 * `pgrep -f` 会匹配到调用它的那个 shell 自己（命令行里就含这个字符串），
 * 结论随调用方式而变。这里改为三条互不重叠的证据：
 *
 *   1. 从 helper 自己打到 stderr 的启动行里解析 **pid**，dispose 后用
 *      `process.kill(pid, 0)` 判定其是否还在（ESRCH = 已退出）；
 *   2. 断言 socket 文件**已被删除**——SIGKILL 路径不可能删除它，
 *      所以这一条恰好把「优雅 SIGTERM」与「超时升级」区分开；
 *   3. 用 `scripts/probe-island-window.swift` 查窗口服务器，证明真的渲染了。
 *
 * 用法：node scripts/e2e-real-helper.mjs [helper 二进制路径]
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const HELPER = process.argv[2] ?? join(ROOT, 'bin', 'DynamicIslandBridge')

let failures = 0
let skipped = 0
const ok = (m) => console.log(`  ✔ ${m}`)
const bad = (m) => { failures++; console.log(`  ✖ ${m}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!existsSync(HELPER)) {
  console.error(`✖ 找不到 helper 二进制：${HELPER}`)
  console.error('  先运行：bash scripts/build-helper.sh')
  process.exit(1)
}

// ---- 编译窗口探针（纯 CoreGraphics，无宏，不走 SwiftPM）----
const dir = mkdtempSync(join(tmpdir(), 'island-e2e-'))
const probe = join(dir, 'probe-window')
function buildProbe() {
  try {
    execFileSync('swiftc', ['-O', '-o', probe, join(ROOT, 'scripts', 'probe-island-window.swift')], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, CLANG_MODULE_CACHE_PATH: join(ROOT, '.swift-cache'), SWIFT_MODULECACHE_PATH: join(ROOT, '.swift-cache') },
    })
    return true
  } catch (error) {
    console.error('✖ 编译窗口探针失败：')
    console.error(String(error.stderr ?? error.message))
    return false
  }
}
const probeReady = buildProbe()

/** 返回 helper 当前占用的窗口数；探针不可用时返回 null。 */
function windowCount() {
  if (!probeReady) return null
  try {
    const out = execFileSync(probe, ['DynamicIslandBridge'], { encoding: 'utf8' })
    return Number(out.match(/MATCHED=(\d+)/)?.[1] ?? 0)
  } catch (error) {
    // 探针在 0 个窗口时以 1 退出。
    const out = String(error.stdout ?? '')
    const match = out.match(/MATCHED=(\d+)/)
    return match ? Number(match[1]) : 0
  }
}

/** 与窗口数联动：探针不可用时跳过（记一条说明，不算通过）。 */
let windowChecksUsable = probeReady
function expectWindow(expected, label) {
  if (!windowChecksUsable) {
    // 明确计为「跳过」而不是通过：跳过不等于验证过。
    skipped++
    console.log(`  ·  ${label}：跳过（无窗口探针）`)
    return
  }
  const count = windowCount()
  if (count === expected) ok(`${label}：窗口数 = ${count}`)
  else bad(`${label}：窗口数 = ${count}，期望 ${expected}`)
}

const mod = await import(new URL(`file://${join(ROOT, 'src', 'index.ts')}`).href)

// ---- 记录日志的假 ctx：插件把 helper 的 stderr 转发到这里的 debug/info ----
// 真宿主按 printf 风格转发（src/index.ts: `log.warn('island helper: %s', line)`），
// 所以这里必须把全部参数拼起来，只取第一个会得到字面量 "island helper: %s"。
const logLines = []
const listeners = []
const disposers = []
const makeLogger = () => ({
  info: (...a) => logLines.push(a.map(String).join(' ')),
  warn: (...a) => logLines.push(a.map(String).join(' ')),
  error: (...a) => logLines.push(a.map(String).join(' ')),
  debug: (...a) => logLines.push(a.map(String).join(' ')),
})

const fakeCtx = {
  logger: () => makeLogger(),
  provide: () => () => {},
  tools: { register: () => () => {} },
  systemPrompt: { section: () => () => {} },
  on: (name, listener) => { listeners.push({ name, listener }); return () => {} },
  effect: (fn, label) => {
    const d = fn()
    disposers.push({ label, disposer: d })
    return () => {}
  },
}

const socketPath = join(dir, 'island.sock')
console.log(`helper: ${HELPER}`)
console.log(`socket: ${socketPath}`)
if (!windowChecksUsable) console.log('提示：窗口探针不可用，渲染相关的断言会标记为「跳过」以区别于「通过」。')

mod.apply(fakeCtx, {
  socketPath,
  helperPath: HELPER,
  connectTimeoutMs: 15_000,
  idleTimeoutMs: 120_000,
  graceMs: 3_000,
})

// ---- 1. 等真 helper bind 并主动连上 ----
const deadline = Date.now() + 20_000
let pid = null
while (Date.now() < deadline) {
  const line = logLines.find((l) => l.includes('island: listening on'))
  const match = line?.match(/pid (\d+)/)
  if (match && existsSync(socketPath)) { pid = Number(match[1]); break }
  await sleep(100)
}

console.log('\n== 真 helper 起来了 ==')
if (pid) ok(`真二进制已 bind 并报出 pid=${pid}（该行由 Swift 侧发出，假 helper 不会产生）`)
else {
  bad('没等到 helper 的启动行——真二进制没跑起来')
  console.log(logLines.join('\n') || '(无日志)')
}
if (existsSync(socketPath)) ok('socket 文件已创建')
else bad('socket 文件不存在')

const alive = (p) => { try { process.kill(p, 0); return true } catch { return false } }
if (pid) {
  if (alive(pid)) ok('启动时该 pid 存活')
  else bad('报出的 pid 立刻就不存在了')
}

const notReachable = logLines.find((l) => l.includes('helper not reachable'))
if (notReachable) bad(`插件认为 helper 不可达：${notReachable}`)
else ok('插件没有报「helper not reachable」——connect 成功')

// ---- 2. 注入一次真实 turn，断言窗口真的出现 ----
console.log('\n== 插件事件 → 真 helper → 真窗口 ==')
expectWindow(0, 'turn/start 之前')

const sessionEvent = listeners.find((l) => l.name === 'session/event')
if (!sessionEvent) {
  bad('apply() 没有注册 session/event 监听器')
} else {
  sessionEvent.listener({ id: 'e2e' }, { type: 'turn/start', data: { turn: 1 } })

  let appeared = false
  const windowDeadline = Date.now() + 6_000
  while (Date.now() < windowDeadline) {
    if (windowCount() > 0) { appeared = true; break }
    await sleep(200)
  }
  if (!windowChecksUsable) {
    skipped++
    console.log('  ·  turn/start 后窗口出现：跳过（无窗口探针）')
  } else if (appeared) {
    ok('turn/start 后窗口出现——事件→状态机→socket→helper→窗口全链路通')
  } else {
    bad('turn/start 后 6s 内没有出现窗口')
  }
}

// ---- 3. 卸载：必须优雅退出，且不是超时升级 ----
console.log('\n== 卸载 ==')
const t0 = Date.now()
for (const { disposer } of disposers) {
  if (typeof disposer === 'function') await disposer()
}
const elapsed = Date.now() - t0

if (elapsed < 3_000) ok(`dispose() 在 ${elapsed}ms 内返回（graceMs=3000，说明不是超时升级）`)
else bad(`dispose() 用了 ${elapsed}ms，疑似走到 SIGKILL 升级`)

const killer = logLines.find((l) => l.includes('did not exit'))
if (killer) bad(`插件报告 helper 未退出：${killer}`)
else ok('插件未报告任何「未退出」错误（它等到了 close 事件）')

if (!existsSync(socketPath)) {
  ok('socket 文件已被删除——SIGKILL 不可能删它，因此走的是优雅 SIGTERM 路径')
} else {
  bad('socket 文件仍在：helper 没跑到信号处理，或根本没收到 SIGTERM')
  rmSync(socketPath, { force: true })
}

await sleep(300)
if (pid) {
  if (!alive(pid)) ok(`pid ${pid} 已不存在（无孤儿）`)
  else bad(`pid ${pid} 仍然存活——dispose() 留下了孤儿进程`)
} else {
  bad('没有拿到 pid，无法判定孤儿')
}

expectWindow(0, 'dispose 之后')

// ---- 4. 收起动画期间来新一轮：岛必须重新出现 ----
//
// `retract` 排在 `hide` 之前是这条检查的全部意义。`hide()` 会 await 约 0.4s 动画，
// 如果复位排在它之后，这段时间里到达的新 turn 的 progress 落在一个「缓冲区仍然可见」的
// 状态上，不产生任何可见性跃迁，岛就会一直隐藏到新 turn 的下一个 progress 帧——
// 没有任何日志、没有报错。旧顺序在同样的脚本下会稳定报 MATCHED=0（已用变异体实测）。
//
// 时序：linger 是 1.2s，hide 动画约 0.4s，所以在 done 之后 1.35s 发送正好落在动画中。
// 若机器较慢导致发送早于 linger，新 turn 会取消 linger、岛根本不隐藏——检查仍然通过，
// 只是不再具备区分力（不会出现假失败）。
async function phaseNewTurnDuringHide() {
  if (!windowChecksUsable) {
    skipped++
    console.log('\n== 收起动画期间来新一轮：跳过（无窗口探针）——跳过不算通过 ==')
    return
  }

  console.log('\n== 收起动画期间来新一轮 ==')
  const raceSocket = join(dir, 'race.sock')
  const child = spawn(HELPER, [raceSocket], { stdio: ['ignore', 'ignore', 'pipe'], detached: true })
  child.stderr.on('data', () => {})

  const send = (line) => new Promise((resolve, reject) => {
    const socket = createConnection(raceSocket, () => {
      socket.write(line)
      socket.end()
      resolve()
    })
    socket.on('error', reject)
  })

  try {
    const until = Date.now() + 8_000
    while (Date.now() < until && !existsSync(raceSocket)) await sleep(100)
    if (!existsSync(raceSocket)) { bad('socket 出现：8000ms 内未满足'); return }

    await send('{"type":"progress","percent":0.5,"mode":"estimated"}\n')
    await sleep(600)
    if (windowCount() === 0) { bad('progress 后窗口未出现，无法继续竞态检查'); return }

    await send('{"type":"done","reason":"completed","ok":true}\n')
    await sleep(1_350) // linger(1.2s) 已过，hide 动画(~0.4s)进行中
    await send('{"type":"progress","percent":0.1,"mode":"estimated","message":"新一轮"}\n')
    await sleep(1_500)

    if (windowCount() > 0) ok('隐藏动画期间到达的新一轮没有被抹掉，岛重新出现')
    else bad('新一轮被上一轮的复位抹掉了：岛保持隐藏（retract 必须排在 hide 之前）')
  } finally {
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
    await sleep(200)
    rmSync(raceSocket, { force: true })
  }
}

// ---- 5. 空闲超时：插件意外消失时，岛不能永远留在最后一次进度上 ----
//
// helper 自己的空闲超时只有在插件不发消息时才生效，而插件默认 120s——
// 太慢，测不了。所以这里单独拉起一个把 --idle-timeout-ms 调到 3s 的实例，
// 从 Node 直接写 NDJSON，验证「出现过 → 静默后自动收起」。
async function phaseIdleTimeout() {
  if (!windowChecksUsable) {
    skipped++
    console.log('\n== 空闲超时：跳过（无窗口探针）——跳过不算通过 ==')
    return
  }

  console.log('\n== 空闲超时（--idle-timeout-ms 3000）==')
  const idleSocket = join(dir, 'idle.sock')
  const child = spawn(HELPER, ['--idle-timeout-ms', '3000', idleSocket], {
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
  })
  child.stderr.on('data', () => {})

  const waitFor = async (predicate, ms, label) => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (predicate()) return true
      await sleep(150)
    }
    bad(`${label}：${ms}ms 内未满足`)
    return false
  }

  try {
    if (!await waitFor(() => existsSync(idleSocket), 8_000, 'socket 出现')) return

    await new Promise((resolve, reject) => {
      const socket = createConnection(idleSocket, () => {
        socket.write('{"type":"hello","version":1}\n')
        socket.write('{"type":"progress","percent":0.5,"mode":"precise"}\n')
        socket.end()
        resolve()
      })
      socket.on('error', reject)
    })

    if (!await waitFor(() => windowCount() > 0, 6_000, 'progress 后窗口出现')) return
    ok('progress 后窗口出现')

    // idle=3s，留 5s 余量；期间不发送任何消息。
    await sleep(5_000)
    if (windowCount() === 0) ok('静默 5s 后窗口自动收起（空闲超时生效）')
    else bad('静默 5s 后窗口仍在——空闲超时没有生效')
  } finally {
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
    await sleep(200)
    rmSync(idleSocket, { force: true })
  }
}

await phaseIdleTimeout()
await phaseNewTurnDuringHide()

rmSync(dir, { recursive: true, force: true })

console.log('')
if (failures > 0) {
  console.log(`结论：${failures} 项失败，${skipped} 项跳过。`)
  process.exitCode = 1
} else if (skipped > 0) {
  // 没有失败的检查不代表验证过：窗口相关的断言全部被跳过时，
  // 「渲染正确」这句话是没有依据的。
  console.log(`结论：无失败，但有 ${skipped} 项检查被跳过（没有窗口探针时无法验证渲染）。`)
  console.log('      跳过不等于通过——这里不报成功。')
  process.exitCode = 1
} else {
  console.log('结论：真插件源码驱动真 helper，渲染与清理都正确，无孤儿。')
}
