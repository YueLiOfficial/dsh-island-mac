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

test('hasOutstandingWork：agent 在运行**不**构成活性（否则岛永久不收）', () => {
  // 这条断言曾经是相反的。它把「agent/status 报 running 即为有未决工作」当成
  // 正确行为固化下来，而那个假设正是实测故障「岛卡在 100% 不消失」的根因。
  // 详见 hasOutstandingWork 的文档注释：该信号单调为真，会让看门狗死锁。
  const m = fresh()
  reduceActivityEvent(m, 'session/created', { session: { id: 'ours' } })
  onAgentStatus(m, { agent: { session: { id: 'ours' } }, status: 'running' })
  assert.equal(m.snapshot().agentRunning, true, '字段仍如实反映状态')
  assert.equal(m.hasOutstandingWork(), false, '但它不得让岛永久保活')
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

// ---------------------------------------------------------------------------
// 回归：agent/status 的 running 不得成为永久粘滞的活性来源
//
// 实测故障：灵动岛卡在 100% 不消失。
//
// 运行时依据（app.asar 里 Agent 的 setPhase）：
//   /** Commit a phase and publish its externally visible status transition. */
//   setPhase(next) { const previousStatus = this.status; ...;
//     if (status !== previousStatus) this.dispatch.emit("agent/status", { status }) }
// 并且同处声明了不变式「no-op agent/status transitions fail」——即不会发冗余的
// 同状态事件。所以 agent 不会"超时"变成 idle：它一直 running，这个信号一旦为真
// 就再也不回落。
//
// 把它当作活性来源会形成死锁：心跳靠它续期，而唯一能把它清掉的路径
// （看门狗到期 → 发 bye → reset）又因为心跳续期而永远走不到。
//
// 因此活性只由「有界且自行终止」的信号决定：进行中的工具调用、未决审批。
// ---------------------------------------------------------------------------

test('回归：agent 一直 running 时，回合结束后仍必须能收起（否则岛卡住不消失）', () => {
  const m = fresh()
  reduceActivityEvent(m, 'session/created', { session: { id: 'ours' } })
  onAgentStatus(m, { agent: { session: { id: 'ours' } }, status: 'running' })
  assert.equal(m.snapshot().agentRunning, true, '前提：信号确实被记录了')

  // 一个完整回合：开始、跑个工具、结束。结束后不应有任何未决工作。
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  onToolPreExecute(m, { callId: 'c1', name: 'Bash', arguments: { command: 'ls' } })
  onToolPostExecute(m, { callId: 'c1', name: 'Bash' })
  reduceSessionEvent(m, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))

  assert.equal(
    m.hasOutstandingWork(), false,
    'agent/status 粘在 running 上不得让岛永久不收（实测故障：卡在 100%）',
  )
})

test('agentRunning 仍然被记录（供未来使用），但不参与活性判据', () => {
  const m = fresh()
  reduceActivityEvent(m, 'session/created', { session: { id: 'ours' } })
  onAgentStatus(m, { agent: { session: { id: 'ours' } }, status: 'running' })
  assert.equal(m.snapshot().agentRunning, true, '字段本身仍应如实反映状态')
  assert.equal(m.hasOutstandingWork(), false, '但它不是活性来源')
})

// ---------------------------------------------------------------------------
// 回归：待办标签不得被当成"未决工作"
//
// 实测故障（截图证据）：任务结束后灵动岛卡在 100%，「当前任务」显示的是待办文案
// `Clean up and final health check`——那正是 todo/write 的 in_progress 项。
//
// 根因：setCurrentTask 把待办文案作为一条**伪 callId 的 in-flight 记录**塞进列表，
// 而这条记录永远不会被移除——没有任何工具会让你 post-execute 掉一个待办。于是
// hasOutstandingWork() 恒为真，心跳无限续期，岛永不收起（直到下一个 turn/start）。
// ---------------------------------------------------------------------------

test('回归：待办标签不构成未决工作（否则回合结束后岛永久不收）', () => {
  const m = fresh()
  reduceSessionEvent(m, ev('todo/write', {
    todos: [
      { content: 'Clean up and final health check', status: 'in_progress' },
      { content: '其它事项', status: 'pending' },
    ],
  }))
  assert.match(m.snapshot().currentTask ?? '', /Clean up/, '待办标签应当显示')

  // 一个完整回合结束后，标签可以留着，但不得构成未决工作。
  reduceSessionEvent(m, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal(
    m.hasOutstandingWork(), false,
    '待办标签描述的是「在做什么」，不是「有什么悬而未决」；把它算进去会让岛永久不收',
  )
})

test('工具进行中仍然构成未决工作（待办标签的修正不能削弱这一点）', () => {
  const m = fresh()
  reduceSessionEvent(m, ev('todo/write', {
    todos: [{ content: '某任务', status: 'in_progress' }],
  }))
  assert.equal(m.hasOutstandingWork(), false, '只有待办时不算未决')

  onToolPreExecute(m, { callId: 'c1', name: 'Bash', arguments: { command: 'ls' } })
  assert.equal(m.hasOutstandingWork(), true, '真的工具在进行中才算未决')

  onToolPostExecute(m, { callId: 'c1', name: 'Bash' })
  assert.equal(m.hasOutstandingWork(), false, '工具结束后回到未决=false')
})

test('真实工具调用优先于待办标签显示（待办是概览，工具是当下）', () => {
  const m = fresh()
  reduceSessionEvent(m, ev('todo/write', {
    todos: [{ content: '实现悬停标签', status: 'in_progress' }],
  }))
  assert.equal(m.snapshot().currentTask, '实现悬停标签')

  onToolPreExecute(m, { callId: 'c1', name: 'Bash', arguments: { command: 'pnpm test', description: '运行测试' } })
  assert.equal(m.snapshot().currentTask, '运行测试', '具体工具比待办概览更贴近「此刻在做什么」')

  onToolPostExecute(m, { callId: 'c1', name: 'Bash' })
  assert.equal(m.snapshot().currentTask, '实现悬停标签', '工具结束后回退到待办标签')
})

test('新回合清空待办标签，避免跨回合残留', () => {
  const m = fresh()
  reduceSessionEvent(m, ev('todo/write', {
    todos: [{ content: '上一回合的事', status: 'in_progress' }],
  }))
  reduceSessionEvent(m, ev('turn/start', { turn: 2 }))
  assert.equal(m.snapshot().currentTask, undefined)
})

test('turn/end 清空进行中的工具与 agentRunning（纵深防御，防永久残留）', () => {
  // 两种会让 hasOutstandingWork() 永久为真、从而让岛永不收起的形状：
  //   1. 有 pre-execute 却没有配对的 post-execute（工具崩了、callId 不匹配）
  //   2. agent/status 报了 running 却再也没有 idle 转换
  // turn/end 是权威边界——回合都结束了，不可能还有"仍在进行的工作"。
  const m = fresh()
  reduceActivityEvent(m, 'session/created', { session: { id: 'ours' } })
  onAgentStatus(m, { agent: { session: { id: 'ours' } }, status: 'running' })
  onToolPreExecute(m, { callId: 'never-finished', name: 'Bash', arguments: { command: 'ls' } })
  assert.equal(m.hasOutstandingWork(), true, '前提：确实处于未决状态')

  reduceSessionEvent(m, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal(m.hasOutstandingWork(), false, '回合结束后不得仍有残留的未决工作')
  assert.equal(m.snapshot().agentRunning, false)
})

test('start 与 finish 必须用同一个 key，否则条目无法移除', () => {
  // 这是一条契约测试：两侧的 key 派生规则必须一致。若哪天有人只改一边
  // （例如给 post 也加了"用工具名兜底"却改了规则），条目会永久残留、
  // 岛永不收起，而且不会有任何报错。
  const m = fresh()
  onToolPreExecute(m, { callId: 'c1', name: 'Bash', arguments: {} })
  assert.equal(m.hasOutstandingWork(), true)
  onToolPostExecute(m, { callId: 'c1', name: 'Bash' })
  assert.equal(m.hasOutstandingWork(), false, '同一个 callId 必须能移除')

  // 两侧都缺 callId 时，都退化为用工具名——规则一致才可移除。
  onToolPreExecute(m, { name: 'Read', arguments: {} })
  assert.equal(m.hasOutstandingWork(), true)
  onToolPostExecute(m, { name: 'Read' })
  assert.equal(m.hasOutstandingWork(), false, '缺 callId 时的兜底规则也必须一致')
})
