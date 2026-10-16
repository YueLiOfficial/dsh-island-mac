import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProgressMachine } from '../src/progress.ts'
import { reduceSessionEvent } from '../src/events.ts'
import {
  reduceActivityEvent,
  onToolPreExecute,
  onToolPostExecute,
  onSessionCreated,
  onSessionDisposed,
  onAgentStatus,
  sessionIdOf,
  resetTrackedSession,
} from '../src/activity.ts'

/** A fresh machine, with the module-level session bookmark cleared. */
function fresh(): ProgressMachine {
  resetTrackedSession()
  const m = new ProgressMachine()
  m.startTurn(1)
  return m
}

const sessionOf = (id: string) => ({ id, session: { id } })

// ---------------------------------------------------------------------------
// 前设：会话识别
// ---------------------------------------------------------------------------

test('sessionIdOf 能从 session 与 agent.session 两条路径取到 id', () => {
  // `session/created` 直接给 session；`tools/*` 给的是 agent，要往下钻一层。
  assert.equal(sessionIdOf({ session: { id: 's1' } }), 's1')
  assert.equal(sessionIdOf({ agent: { session: { id: 's2' } } }), 's2')
})

test('sessionIdOf 对畸形载荷返回 null 而不抛异常', () => {
  for (const bad of [null, undefined, 42, 'x', {}, { session: null }, { session: {} }, { agent: 'x' }]) {
    assert.doesNotThrow(() => sessionIdOf(bad))
    assert.equal(sessionIdOf(bad), null, `未对 ${JSON.stringify(bad)} 返回 null`)
  }
})

test('session/created 记录会话；后续不同会话被忽略（子代理不能抢走显示）', () => {
  const m = fresh()
  onSessionCreated(m, { session: { id: 'ours' } })

  // 子代理会创建自己的会话，必须被忽略，否则它会把岛从用户的任务上抢走。
  const other = onSessionCreated(m, { session: { id: 'subagent' } })
  assert.equal(other.changed, false)
  assert.equal(other.activity, undefined)

  // 证明被跟踪的仍是 ours：agent/status 只对 ours 生效。
  assert.equal(onAgentStatus(m, { agent: { session: { id: 'subagent' } }, status: 'running' }).changed, false)
  assert.equal(onAgentStatus(m, { agent: { session: { id: 'ours' } }, status: 'running' }).changed, true)
})

test('session/created 本身不显示岛（空会话不该闪一下）', () => {
  const m = fresh()
  const r = onSessionCreated(m, { session: { id: 's1' } })
  assert.equal(r.changed, false)
  assert.equal(r.activity, true, '但它算作存活信号')
})

test('session/disposed 只对自己的会话生效，且会重置状态机', () => {
  const m = fresh()
  onSessionCreated(m, { session: { id: 'ours' } })
  onAgentStatus(m, { agent: { session: { id: 'ours' } }, status: 'running' })

  // 别的会话结束不能收掉我们的岛。
  assert.equal(onSessionDisposed(m, { session: { id: 'other' } }).changed, false)
  assert.equal(m.snapshot().state, 'estimated')

  const r = onSessionDisposed(m, { session: { id: 'ours' } })
  assert.equal(r.changed, true)
  assert.equal(m.snapshot().state, 'idle')
  assert.equal(m.snapshot().agentRunning, false, '重置必须清掉 agentRunning')
})

// ---------------------------------------------------------------------------
// agent/status
// ---------------------------------------------------------------------------

test('agent/status 只改活性、不改百分比，且不产生可见文字', () => {
  const m = fresh()
  onSessionCreated(m, { session: { id: 'ours' } })
  const before = m.snapshot().percent

  const r = onAgentStatus(m, { agent: { session: { id: 'ours' } }, status: 'running' })
  assert.equal(m.snapshot().agentRunning, true)
  assert.equal(m.snapshot().percent, before, 'agent/status 不得改动进度')
  assert.equal(r.snapshot.currentTask, undefined, '活性不该变成标签')
})

test('agent/status 幂等：状态没变就不上报变更', () => {
  const m = fresh()
  onSessionCreated(m, { session: { id: 'ours' } })
  onAgentStatus(m, { agent: { session: { id: 'ours' } }, status: 'running' })
  assert.equal(onAgentStatus(m, { agent: { session: { id: 'ours' } }, status: 'running' }).changed, false)
  assert.equal(onAgentStatus(m, { agent: { session: { id: 'ours' } }, status: 'idle' }).changed, true)
})

test('agent/status 缺少 status 字段时不改动状态', () => {
  const m = fresh()
  onSessionCreated(m, { session: { id: 'ours' } })
  for (const bad of [null, undefined, {}, { agent: { session: { id: 'ours' } } }]) {
    assert.doesNotThrow(() => onAgentStatus(m, bad))
    assert.equal(onAgentStatus(m, bad).changed, false)
  }
})

// ---------------------------------------------------------------------------
// tools/pre-execute + post-execute
// ---------------------------------------------------------------------------

test('tools/pre-execute 设置标签且不动百分比', () => {
  const m = fresh()
  const before = m.snapshot().percent
  const r = onToolPreExecute(m, {
    callId: 'c1',
    name: 'Bash',
    arguments: { command: 'pnpm test', description: '运行测试' },
  })
  assert.equal(r.snapshot.currentTask, '运行测试')
  assert.equal(r.snapshot.percent, before, 'pre-execute 不得改动进度')
})

test('tools/pre-execute 接受已解析的对象参数（Cordis 侧的真实形状）', () => {
  // 这是关键：session/event 给的是 JSON 字符串，Cordis 给的是对象。
  // 只支持一种形状会静默退化成通用文案，而不是报错。
  const m = fresh()
  onToolPreExecute(m, { callId: 'c1', name: 'Read', arguments: { file_path: 'src/a.ts' } })
  assert.equal(m.snapshot().currentTask, '查看文件：src/a.ts')
})

test('tools/post-execute 让标签回退到仍在执行的工具，而不是清空', () => {
  const m = fresh()
  onToolPreExecute(m, { callId: 'outer', name: 'Read', arguments: { file_path: 'a.ts' } })
  onToolPreExecute(m, { callId: 'inner', name: 'Grep', arguments: { pattern: 'TODO' } })
  assert.equal(m.snapshot().currentTask, '搜索内容：TODO')

  onToolPostExecute(m, { callId: 'inner', name: 'Grep' })
  assert.equal(m.snapshot().currentTask, '查看文件：a.ts', '应回退到外层工具')
})

test('tools/post-execute 对未知 callId 是空操作（保住 todo 标签）', () => {
  const m = fresh()
  // todo 标签用的是一个伪 callId，任何真实工具结束都不该把它清掉。
  m.setCurrentTask('实现悬停标签')
  const r = onToolPostExecute(m, { callId: 'some-tool-call', name: 'Bash' })
  assert.equal(r.changed, false)
  assert.equal(m.snapshot().currentTask, '实现悬停标签')
})

test('重复的 callId 不会累积（事件重放安全）', () => {
  const m = fresh()
  onToolPreExecute(m, { callId: 'c1', name: 'Bash', arguments: { command: 'ls' } })
  onToolPreExecute(m, { callId: 'c1', name: 'Bash', arguments: { command: 'ls' } })
  onToolPostExecute(m, { callId: 'c1', name: 'Bash' })
  assert.equal(m.snapshot().currentTask, undefined, '一次 post 就应清掉，不该残留一份')
})

test('tools/* 畸形载荷不抛异常且不产生标签', () => {
  const m = fresh()
  for (const bad of [null, undefined, 42, 'x', {}, { name: '' }, { name: '   ' }]) {
    assert.doesNotThrow(() => onToolPreExecute(m, bad as never))
    assert.equal(onToolPreExecute(m, bad as never).changed, false)
  }
  for (const bad of [null, undefined, 42, 'x', {}]) {
    assert.doesNotThrow(() => onToolPostExecute(m, bad as never))
  }
})

test('缺少 callId 时用工具名兜底（pre 能记住，post 仍能清掉）', () => {
  const m = fresh()
  onToolPreExecute(m, { name: 'Bash', arguments: { command: 'ls' } })
  assert.equal(m.snapshot().currentTask, '执行命令：ls')
  onToolPostExecute(m, { name: 'Bash' })
  assert.equal(m.snapshot().currentTask, undefined)
})

// ---------------------------------------------------------------------------
// subagent
// ---------------------------------------------------------------------------

test('subagent/start 与 end 维护计数，按 runId 配对', () => {
  const m = fresh()
  reduceActivityEvent(m, 'subagent/start', { runId: 'r1', id: 'a1' })
  reduceActivityEvent(m, 'subagent/start', { runId: 'r2', id: 'a2' })
  assert.equal(m.snapshot().subagentCount, 2)

  reduceActivityEvent(m, 'subagent/end', { runId: 'r1', id: 'a1', stopReason: 'completed' })
  assert.equal(m.snapshot().subagentCount, 1, '必须按 runId 移除，而不是递减')
})

test('单个子代理不改动标签（不是新闻），两个以上才加后缀', () => {
  const m = fresh()
  onToolPreExecute(m, { callId: 'c1', name: 'Read', arguments: { file_path: 'a.ts' } })

  reduceActivityEvent(m, 'subagent/start', { runId: 'r1' })
  assert.equal(m.snapshot().currentTask, '查看文件：a.ts', '1 个子代理不该改文案')

  const r = reduceActivityEvent(m, 'subagent/start', { runId: 'r2' })
  assert.equal(r.changed, true)
  assert.match(m.snapshot().currentTask ?? '', /2 子代理/)
})

test('没有工具标签时，多个子代理单独成文', () => {
  const m = fresh()
  reduceActivityEvent(m, 'subagent/start', { runId: 'r1' })
  reduceActivityEvent(m, 'subagent/start', { runId: 'r2' })
  assert.equal(m.snapshot().currentTask, '2 个子代理运行中')
})

test('重复 start 同一 runId 不重复计数；未知 end 不产生负数', () => {
  const m = fresh()
  reduceActivityEvent(m, 'subagent/start', { runId: 'r1' })
  reduceActivityEvent(m, 'subagent/start', { runId: 'r1' })
  assert.equal(m.snapshot().subagentCount, 1)

  const r = reduceActivityEvent(m, 'subagent/end', { runId: 'never-started' })
  assert.equal(r.changed, false)
  assert.equal(m.snapshot().subagentCount, 1)
})

// ---------------------------------------------------------------------------
// 调度器与不变式
// ---------------------------------------------------------------------------

test('未知事件类型降级为无操作（Cordis Events 可扩展）', () => {
  const m = fresh()
  const before = m.snapshot()
  for (const t of ['future/event', 'tools/execute', 'agent/error']) {
    const r = reduceActivityEvent(m, t, { anything: true })
    assert.equal(r.changed, false, `${t} 被误当作活动事件`)
  }
  assert.deepEqual(m.snapshot(), before)
})

test('七类事件没有一类会改动百分比（这是核心不变式）', () => {
  const m = new ProgressMachine()
  resetTrackedSession()
  m.startTurn(1)
  onSessionCreated(m, { session: { id: 'ours' } })
  const baseline = m.snapshot().percent

  const events: Array<[string, unknown]> = [
    ['session/created', { session: { id: 'ours' } }],
    ['agent/status', { agent: { session: { id: 'ours' } }, status: 'running' }],
    ['subagent/start', { runId: 'r1' }],
    ['subagent/end', { runId: 'r1' }],
  ]
  for (const [type, payload] of events) {
    reduceActivityEvent(m, type, payload)
    assert.equal(m.snapshot().percent, baseline, `${type} 改动了百分比`)
  }

  onToolPreExecute(m, { callId: 'c1', name: 'Bash', arguments: { command: 'ls' } })
  assert.equal(m.snapshot().percent, baseline, 'pre-execute 改动了百分比')
  onToolPostExecute(m, { callId: 'c1', name: 'Bash' })
  assert.equal(m.snapshot().percent, baseline, 'post-execute 改动了百分比')
})

test('新 turn 清空进行中的工具与子代理，避免跨回合残留', () => {
  const m = new ProgressMachine()
  resetTrackedSession()
  m.startTurn(1)
  onToolPreExecute(m, { callId: 'c1', name: 'Bash', arguments: { command: 'ls' } })
  reduceActivityEvent(m, 'subagent/start', { runId: 'r1' })

  m.startTurn(2)
  assert.equal(m.snapshot().currentTask, undefined)
  assert.equal(m.snapshot().subagentCount, 0)
})

// `reduceSessionEvent` 期待持久化事件的形状 `{ type, data }`；
// `reduceActivityEvent` 直接收 payload。两者签名不同，别混用。
const ev = (type: string, data: unknown) => ({ type, data })

// ---------------------------------------------------------------------------
// hasOutstandingWork —— 灵动岛的活性判据
//
// 这条判据是唯一决定"岛该不该在屏幕上"的东西，而它已经因为看得太窄而出过
// 两次故障：先是只认「未决审批」，于是普通工具调用（ask_user_question 阻塞
// 219 秒）期间岛被收起；再往前，是只认 agent/status 的 running。
// 所以这里把三种"悬而未决"逐条钉住，并确保它们都能回到 false——
// 只会变 true 的判据等于永不收起。
// ---------------------------------------------------------------------------

test('hasOutstandingWork：工具进行中为真，结束后回到假', () => {
  const m = fresh()
  assert.equal(m.hasOutstandingWork(), false, 'turn/start 后没有未决工作是正常的')

  onToolPreExecute(m, { callId: 'c1', name: 'Bash', arguments: { command: 'ls' } })
  assert.equal(m.hasOutstandingWork(), true, '工具进行中必须有未决工作')

  onToolPostExecute(m, { callId: 'c1', name: 'Bash' })
  assert.equal(m.hasOutstandingWork(), false, '工具结束后必须回到假，否则永不收起')
})

test('hasOutstandingWork：未决审批为真，裁决后回到假', () => {
  const m = fresh()
  reduceSessionEvent(m, ev('approval/asked', { id: 'r1', toolName: 'bash' }))
  assert.equal(m.hasOutstandingWork(), true)

  reduceSessionEvent(m, ev('approval/decided', { id: 'r1', outcome: 'rejected' }))
  assert.equal(m.hasOutstandingWork(), false)
})

test('hasOutstandingWork：agent 在运行为真', () => {
  const m = fresh()
  onAgentStatus(m, { agent: { session: { id: 'ours' } }, status: 'running' })
  // 该调用的会话过滤依赖模块级跟踪状态，所以先建立跟踪。
  const m2 = fresh()
  reduceActivityEvent(m2, 'session/created', { session: { id: 'ours' } })
  onAgentStatus(m2, { agent: { session: { id: 'ours' } }, status: 'running' })
  assert.equal(m2.hasOutstandingWork(), true)
  onAgentStatus(m2, { agent: { session: { id: 'ours' } }, status: 'idle' })
  assert.equal(m2.hasOutstandingWork(), false)
  // 未跟踪的会话不得影响本机状态。
  assert.equal(m.hasOutstandingWork(), false)
})

test('hasOutstandingWork：多种未决同时存在时，清掉一个仍为真', () => {
  const m = fresh()
  reduceSessionEvent(m, ev('approval/asked', { id: 'r1', toolName: 'bash' }))
  onToolPreExecute(m, { callId: 'c1', name: 'Bash', arguments: { command: 'ls' } })
  assert.equal(m.hasOutstandingWork(), true)

  onToolPostExecute(m, { callId: 'c1', name: 'Bash' })
  assert.equal(m.hasOutstandingWork(), true, '审批仍未决')

  reduceSessionEvent(m, ev('approval/decided', { id: 'r1', outcome: 'allowed-once' }))
  assert.equal(m.hasOutstandingWork(), false, '全部结清后才回到假')
})

test('hasOutstandingWork：新 turn 清空，不跨回合残留', () => {
  const m = fresh()
  onToolPreExecute(m, { callId: 'c1', name: 'Bash', arguments: { command: 'ls' } })
  reduceSessionEvent(m, ev('approval/asked', { id: 'r1', toolName: 'bash' }))
  assert.equal(m.hasOutstandingWork(), true)

  reduceSessionEvent(m, ev('turn/start', { turn: 2 }))
  assert.equal(m.hasOutstandingWork(), false, '新回合必须结清上一回合的未决状态')
})

test('hasOutstandingWork：reset 后为假', () => {
  const m = fresh()
  onToolPreExecute(m, { callId: 'c1', name: 'Bash', arguments: { command: 'ls' } })
  m.reset()
  assert.equal(m.hasOutstandingWork(), false)
})
