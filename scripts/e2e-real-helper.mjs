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

/**
 * 返回匹配的窗口数；探针不可用时返回 null。
 *
 * 传入 `pid` 时只统计该进程拥有的窗口。**总是应该传**：一个实际挂载了本插件的
 * 开发机上，屏幕上永远有另一个 `DynamicIslandBridge` 的岛，按进程名匹配会把它
 * 一起数进去。这个缺陷实测造成过两种错误：所有「期望 0 个窗口」的断言必然失败，
 * 而更糟的是「期望窗口消失」的断言会**对着别人的岛通过**——即假阴性。
 * 探针因此支持按 PID 过滤（见 probe-island-window.swift）。
 */
function windowCount(pid = null) {
  if (!probeReady) return null
  const args = pid === null ? ['DynamicIslandBridge'] : ['DynamicIslandBridge', String(pid)]
  try {
    const out = execFileSync(probe, args, { encoding: 'utf8' })
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
function expectWindow(expected, label, pid = null) {
  if (!windowChecksUsable) {
    // 明确计为「跳过」而不是通过：跳过不等于验证过。
    skipped++
    console.log(`  ·  ${label}：跳过（无窗口探针）`)
    return
  }
  const count = windowCount(pid)
  if (count === expected) ok(`${label}：窗口数 = ${count}`)
  else bad(`${label}：窗口数 = ${count}，期望 ${expected}`)
}

/**
 * 从 helper 的 stderr 里解析它自己报出的 pid。
 *
 * helper 的启动行是唯一把「这个进程」与「这个 socket」绑起来的证据；拿到 pid 后
 * 窗口断言才能只针对它，而不是屏幕上任意一个同名进程。
 */
async function waitForHelperPid(readStderr, ms = 8_000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const match = readStderr().match(/listening on .*pid (\d+)/)
    if (match) return Number(match[1])
    await sleep(100)
  }
  return null
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
expectWindow(0, 'turn/start 之前', pid)

const sessionEvent = listeners.find((l) => l.name === 'session/event')
if (!sessionEvent) {
  bad('apply() 没有注册 session/event 监听器')
} else {
  sessionEvent.listener({ id: 'e2e' }, { type: 'turn/start', data: { turn: 1 } })

  let appeared = false
  const windowDeadline = Date.now() + 6_000
  while (Date.now() < windowDeadline) {
    if (windowCount(pid) > 0) { appeared = true; break }
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

expectWindow(0, 'dispose 之后', pid)

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
  let raceStderr = ''
  child.stderr.on('data', (d) => { raceStderr += d })

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

    const racePid = await waitForHelperPid(() => raceStderr)
    if (racePid === null) { bad('未解析出 helper pid，无法做精确窗口断言'); return }

    await send('{"type":"progress","percent":0.5,"mode":"estimated"}\n')
    await sleep(600)
    if (windowCount(racePid) === 0) { bad('progress 后窗口未出现，无法继续竞态检查'); return }

    await send('{"type":"done","reason":"completed","ok":true}\n')
    await sleep(1_350) // linger(1.2s) 已过，hide 动画(~0.4s)进行中
    await send('{"type":"progress","percent":0.1,"mode":"estimated","message":"新一轮"}\n')
    await sleep(1_500)

    if (windowCount(racePid) > 0) ok('隐藏动画期间到达的新一轮没有被抹掉，岛重新出现')
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
  let idleStderr = ''
  child.stderr.on('data', (d) => { idleStderr += d })

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

    const idlePid = await waitForHelperPid(() => idleStderr)
    if (!await waitFor(() => windowCount(idlePid) > 0, 6_000, 'progress 后窗口出现')) return
    ok('progress 后窗口出现')

    // idle=3s，留 5s 余量；期间不发送任何消息。
    await sleep(5_000)
    if (windowCount(idlePid) === 0) ok('静默 5s 后窗口自动收起（空闲超时生效）')
    else bad('静默 5s 后窗口仍在——空闲超时没有生效')
  } finally {
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
    await sleep(200)
    rmSync(idleSocket, { force: true })
  }
}

/**
 * 起一个独立 helper + 独立插件实例，返回驱动它所需的一切。
 *
 * 两个"保持在屏"用例此前各自复制了一遍这些代码，而重复恰恰藏住了问题：每个
 * 阶段的 socket / 模块实例 / 诊断稍有不同，排查时分不清差异是真实的还是抄写
 * 误差。集中一处后，各阶段只描述自己关心的行为。
 */
async function startIsolatedPhase(name, idleMs, socketName) {
  const phaseSocket = join(dir, socketName)
  const child = spawn(HELPER, ['--idle-timeout-ms', String(idleMs), phaseSocket], {
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
  })
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d })

  const listeners = []
  const disposers = []
  const ctx = {
    ...fakeCtx,
    on: (n, l) => { listeners.push({ name: n, listener: l }); return () => {} },
    effect: (fn, label) => { const d = fn(); disposers.push({ label, disposer: d }); return () => {} },
  }

  const until = Date.now() + 8_000
  while (Date.now() < until && !existsSync(phaseSocket)) await sleep(100)
  if (!existsSync(phaseSocket)) { bad(`${name}：socket 出现：8000ms 内未满足`); return null }

  // 独立模块实例：activity.ts 把「跟踪哪个会话」存在模块级变量里，共用实例会让
  // 各阶段互相把对方的会话当成"不是我们的"而忽略。
  const freshMod = await import(new URL(`file://${join(ROOT, 'src', 'index.ts')}?phase=${name}`).href)
  freshMod.apply(ctx, {
    socketPath: phaseSocket,
    helperPath: HELPER,
    connectTimeoutMs: 15_000,
    idleTimeoutMs: idleMs,
    graceMs: 3_000,
  })

  const emit = (n, ...args) => { for (const l of listeners) if (l.name === n) l.listener(...args) }
  const pid = await waitForHelperPid(() => stderr)
  if (pid === null) { bad(`${name}：未解析出 helper pid`); return null }

  const cleanup = async () => {
    for (const { disposer } of disposers) {
      if (typeof disposer === 'function') { try { await disposer() } catch { /* best effort */ } }
    }
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
    await sleep(200)
    rmSync(phaseSocket, { force: true })
  }

  return { emit, pid, cleanup }
}

/** 轮询窗口是否达到期望状态。固定睡眠与异步收起时机相撞过，所以用轮询。 */
async function waitForWindowState(predicate, ms, label) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (predicate()) return true
    await sleep(200)
  }
  bad(`${label}：${ms}ms 内未满足`)
  return false
}

/**
 * 审批挂起期间必须不被空闲超时收起。
 *
 * 这条用例存在的理由是一次真实故障：用户发起提权审批后等了两三分钟，
 * 灵动岛在空闲阈值上消失了——而那正是需要它留在屏幕上的时刻。
 *
 * 与 `phaseIdleTimeout` 的关键区别：那个阶段直接向 helper 写 NDJSON，**绕开了
 * 插件**，因此无法覆盖任何状态机逻辑。这里必须驱动真插件。
 *
 * 断言刻意成对：挂起期间**不收起**，裁决之后**仍能收起**。只测前者会把
 * "永久抑制"当成修复——那是另一个 bug。
 */
async function phaseApprovalHoldsIsland() {
  if (!windowChecksUsable) {
    skipped++
    console.log('\n== 审批挂起期间不收起：跳过（无窗口探针）——跳过不算通过 ==')
    return
  }

  const idleMs = 5_000
  console.log(`\n== 审批挂起期间不收起（idleTimeoutMs=${idleMs}）==`)
  const phase = await startIsolatedPhase('approval', idleMs, 'approval.sock')
  if (phase === null) return

  try {
    phase.emit('session/created', { id: 'approval-e2e' })
    phase.emit('session/event', { id: 'approval-e2e' }, { type: 'turn/start', data: { turn: 1 } })

    if (!await waitForWindowState(() => windowCount(phase.pid) > 0, 6_000, 'turn/start 后窗口出现')) return
    ok('turn/start 后窗口出现')

    phase.emit('session/event', { id: 'approval-e2e' }, {
      type: 'approval/asked',
      data: { id: 'req-1', toolName: 'bash', callId: 'call_1', reason: 'escalate sandbox' },
    })

    // 必须**超过**整整一个空闲周期，否则看门狗还没触发过，窗口"仍在"什么也证明不了。
    const holdStart = Date.now()
    await sleep(idleMs + 2_000)
    const held = (Date.now() - holdStart) / 1000
    if (windowCount(phase.pid) > 0) {
      ok(`审批挂起期间静默 ${held.toFixed(1)}s（超过空闲阈值）窗口仍在——两侧看门狗都被心跳刷新`)
    } else {
      bad('审批挂起期间窗口消失了——挂起期间没有维持心跳')
    }

    phase.emit('session/event', { id: 'approval-e2e' }, {
      type: 'approval/decided',
      data: { id: 'req-1', outcome: 'allowed-once' },
    })
    if (await waitForWindowState(() => windowCount(phase.pid) === 0, idleMs * 3, 'approval/decided 后窗口自动收起')) {
      ok('approval/decided 之后空闲超时恢复正常，窗口自动收起（不是永久抑制）')
    }
  } finally {
    await phase.cleanup()
  }
}

/**
 * 一次阻塞在用户身上的普通工具调用，同样不得被空闲超时收起。
 *
 * 这条用例来自第二个真实故障，它也证明了只测一条路径有多危险：修复第一版只
 * 覆盖「未决审批」，用户在选项界面上停留时灵动岛仍然消失。会话日志给出了确凿
 * 数据——`ask_user_question` 的 `tool/call` 与 `tool/result` 相隔 219 秒，
 * 期间**没有任何 `approval/*` 事件**，所以以审批为条件的心跳完全不适用。
 *
 * 判据因此从「是否在等审批」放宽为「是否有事情悬而未决」。这条用例专测第二种。
 */
async function phaseToolWaitHoldsIsland() {
  if (!windowChecksUsable) {
    skipped++
    console.log('\n== 工具等待期间不收起：跳过（无窗口探针）——跳过不算通过 ==')
    return
  }

  const idleMs = 5_000
  console.log(`\n== 工具等待期间不收起（idleTimeoutMs=${idleMs}）==`)
  const phase = await startIsolatedPhase('toolwait', idleMs, 'toolwait.sock')
  if (phase === null) return

  try {
    phase.emit('session/created', { id: 'toolwait-e2e' })
    phase.emit('session/event', { id: 'toolwait-e2e' }, { type: 'turn/start', data: { turn: 1 } })

    if (!await waitForWindowState(() => windowCount(phase.pid) > 0, 6_000, 'turn/start 后窗口出现')) return
    ok('turn/start 后窗口出现')

    // `tools/pre-execute` 是中间件，必须给 `next` 续延——真实宿主会传，这里也要传，
    // 否则插件里 `return next()` 会抛 TypeError。这个续延同时是断言点：插件必须
    // 原样直通，认领就等于拦截了工具调用。
    let prePassed = false
    phase.emit('tools/pre-execute', {
      callId: 'call_waiting',
      name: 'AskUserQuestion',
      arguments: { question: '请选择' },
    }, async () => { prePassed = true; return { kind: 'allow' } })
    await sleep(100)
    if (prePassed) ok('pre-execute 直通（没有拦截工具调用）')
    else bad('pre-execute 没有调用 next() —— 会拦截会话内所有工具调用')

    const holdStart = Date.now()
    await sleep(idleMs + 2_000)
    const held = (Date.now() - holdStart) / 1000
    if (windowCount(phase.pid) > 0) {
      ok(`工具等待期间静默 ${held.toFixed(1)}s（超过空闲阈值）窗口仍在——未决的工具调用维持了心跳`)
    } else {
      bad('工具等待期间窗口消失了——心跳漏掉了阻塞在用户身上的工具调用')
    }

    let postPassed = false
    phase.emit('tools/post-execute', { callId: 'call_waiting', name: 'AskUserQuestion' }, {},
      async () => { postPassed = true; return { kind: 'accept' } })
    await sleep(100)
    if (postPassed) ok('post-execute 直通（没有拦截结果）')
    else bad('post-execute 没有调用 next()')

    if (await waitForWindowState(() => windowCount(phase.pid) === 0, idleMs * 3, '工具返回后窗口自动收起')) {
      ok('工具返回后空闲超时恢复正常，窗口自动收起（不是永久抑制）')
    }
  } finally {
    await phase.cleanup()
  }
}

/**
 * 带未完成待办的回合结束后，窗口必须仍然收起。
 *
 * 这条用例来自第三个真实故障（用户截图）：「当前任务」显示的是待办文案
 * `Clean up and final health check`，而岛卡在 100% 不消失。
 *
 * 根因：待办标签曾被当作一条 in-flight 记录存进「进行中的工具」列表，而那条记录
 * **永远不会被移除**——没有任何工具会让你 post-execute 掉一个待办。于是
 * hasOutstandingWork() 恒为真、心跳无限续期、岛永不收起。
 *
 * 此前的保持在屏用例都不涉及待办，所以结构上就不可能发现它。这条补上那个缺口：
 * 注入一个 in_progress 待办（制造"有未决工作"的假象），再让回合正常结束，断言
 * 窗口仍然收起。
 */
async function phaseTodoLabelDoesNotKeepIslandUp() {
  if (!windowChecksUsable) {
    skipped++
    console.log('\n== 待办标签不阻止收起：跳过（无窗口探针）——跳过不算通过 ==')
    return
  }

  const idleMs = 5_000
  console.log(`\n== 待办标签不阻止收起（idleTimeoutMs=${idleMs}）==`)
  const phase = await startIsolatedPhase('todolabel', idleMs, 'todolabel.sock')
  if (phase === null) return

  try {
    phase.emit('session/created', { id: 'todolabel-e2e' })
    phase.emit('session/event', { id: 'todolabel-e2e' }, { type: 'turn/start', data: { turn: 1 } })

    if (!await waitForWindowState(() => windowCount(phase.pid) > 0, 6_000, 'turn/start 后窗口出现')) return
    ok('turn/start 后窗口出现')

    // 制造「有一个待办正在进行」的状态：这正是导致假阳性的输入。
    phase.emit('session/event', { id: 'todolabel-e2e' }, {
      type: 'todo/write',
      data: { todos: [{ content: 'Clean up and final health check', status: 'in_progress' }] },
    })

    // 回合正常结束。此时不应再有任何「悬而未决」的东西。
    phase.emit('session/event', { id: 'todolabel-e2e' }, {
      type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } },
    })

    // linger 约 1.2s + 一个空闲周期。给足余量。
    const collapsed = await waitForWindowState(
      () => windowCount(phase.pid) === 0,
      idleMs * 2 + 3_000,
      '回合结束后窗口自动收起',
    )
    if (collapsed) {
      ok('带未完成待办时，回合结束后窗口仍自动收起（待办标签未被视为未决工作）')
    } else {
      bad('窗口未收起——待办标签被当成了未决工作，心跳无限续期（这正是截图里的卡死）')
    }
  } finally {
    await phase.cleanup()
  }
}

await phaseIdleTimeout()
await phaseNewTurnDuringHide()
await phaseApprovalHoldsIsland()
await phaseToolWaitHoldsIsland()
await phaseTodoLabelDoesNotKeepIslandUp()

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
