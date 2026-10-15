import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProgressMachine } from '../src/progress.ts'
import { reduceSessionEvent } from '../src/events.ts'

const ev = (type: string, data: unknown) => ({ type, data })

test('turn/start 进入估算并给出 5%', () => {
  const m = new ProgressMachine()
  const r = reduceSessionEvent(m, ev('turn/start', { turn: 7 }))
  assert.equal(r.changed, true)
  assert.equal(r.snapshot.state, 'estimated')
  assert.equal(r.snapshot.percent, 0.05)
})

test('step/end 推进估算', () => {
  const m = new ProgressMachine()
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  const r = reduceSessionEvent(m, ev('step/end', { turn: 1, step: 10 }))
  assert.ok(r.snapshot.percent > 0.05)
  assert.equal(r.snapshot.mode, 'estimated')
})

test('todo/write 给出精确比例并切到 precise（加权公式）', () => {
  const m = new ProgressMachine()
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  const r = reduceSessionEvent(m, ev('todo/write', {
    todos: [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'completed' },
      { content: 'c', status: 'pending' },
      { content: 'd', status: 'in_progress' },
    ],
  }))
  // (completed + 0.5 * in_progress) / total = (2 + 0.5) / 4
  assert.equal(r.todoRatio, 0.625)
  assert.equal(r.snapshot.state, 'precise')
  assert.equal(r.snapshot.percent, 0.625)
})

test('todo 加权公式：无任何完成项时也反映进行中的工作', () => {
  const m = new ProgressMachine()
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  const r = reduceSessionEvent(m, ev('todo/write', {
    todos: [
      { content: 'a', status: 'in_progress' },
      { content: 'b', status: 'pending' },
      { content: 'c', status: 'pending' },
      { content: 'd', status: 'pending' },
    ],
  }))
  // (0 + 0.5) / 4 = 0.125；纯 completed/total 会给出 0.0
  assert.equal(r.todoRatio, 0.125)
  assert.ok(r.snapshot.percent > 0, '不应显示 0%')
})

test('todo 全部完成时比值仍恰为 1.0，但显示值封顶 0.9', () => {
  const m = new ProgressMachine()
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  const r = reduceSessionEvent(m, ev('todo/write', {
    todos: [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'completed' },
      { content: 'c', status: 'completed' },
    ],
  }))
  // (3 + 0) / 3 = 1.0，不得因浮点误差变成 0.999…
  // 比值是「清单的观察」，仍然如实报告。
  assert.equal(r.todoRatio, 1)
  // 但显示值封顶：100% 必须只表示「这个 turn 结束了」。
  assert.equal(r.snapshot.percent, 0.9)
})

test('清单全完成但 turn 未结束时停在 90%，只有 turn/end completed 才到 100%', () => {
  const m = new ProgressMachine()
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  reduceSessionEvent(m, ev('todo/write', {
    todos: [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'completed' },
    ],
  }))
  // 收尾阶段：模型还会继续调用工具，值不得声称完成。
  const during = reduceSessionEvent(m, ev('tool/call', {
    turn: 1,
    step: 2,
    name: 'Read',
    arguments: JSON.stringify({ file_path: 'a.ts' }),
  }))
  assert.equal(during.snapshot.percent, 0.9)
  // 真正的完成信号。
  const done = reduceSessionEvent(m, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal(done.snapshot.percent, 1)
})

test('todo 项数增加导致比值下降时，显示值保持不变（单调度）', () => {
  const m = new ProgressMachine()
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  reduceSessionEvent(m, ev('todo/write', {
    todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }],
  }))
  const high = m.snapshot().percent   // (2+0)/2 = 1.0
  const r = reduceSessionEvent(m, ev('todo/write', {
    todos: [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'completed' },
      { content: 'c', status: 'pending' },
      { content: 'd', status: 'pending' },
    ],
  }))
  assert.equal(r.todoRatio, 0.5)            // 比值确实降了
  assert.equal(r.snapshot.percent, high)    // 但显示值不降
})

test('todo 权重常量 0.5 可单点替换（若日后需调为 0.25）', () => {
  // 本测试是「改动点集中」的守护：加权公式只在一处计算，
  // 调整常量只需改一个地方而不必改多处调用。
  const m = new ProgressMachine()
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  const r = reduceSessionEvent(m, ev('todo/write', {
    todos: [
      { content: 'a', status: 'in_progress' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'pending' },
      { content: 'd', status: 'pending' },
    ],
  }))
  // (0 + 0.5*2) / 4 = 0.25
  assert.equal(r.todoRatio, 0.25)
})

test('todo/write 空数组不产生 NaN，且不改动进度', () => {
  const m = new ProgressMachine()
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  const before = m.snapshot().percent
  const r = reduceSessionEvent(m, ev('todo/write', { todos: [] }))
  assert.equal(r.todoRatio, null)
  assert.equal(r.snapshot.percent, before)
  assert.ok(Number.isFinite(r.snapshot.percent))
})

test('畸形 todo/write 载荷不抛异常', () => {
  const m = new ProgressMachine()
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  for (const bad of [null, undefined, 42, 'x', {}, { todos: 'nope' }, { todos: [null, 1, {}] }]) {
    assert.doesNotThrow(() => reduceSessionEvent(m, ev('todo/write', bad)))
  }
})

test('turn/end completed 与 aborted 分流正确', () => {
  const a = new ProgressMachine()
  reduceSessionEvent(a, ev('turn/start', { turn: 1 }))
  const done = reduceSessionEvent(a, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal(done.snapshot.percent, 1)
  assert.equal(done.snapshot.ok, true)

  const b = new ProgressMachine()
  reduceSessionEvent(b, ev('turn/start', { turn: 1 }))
  reduceSessionEvent(b, ev('step/end', { turn: 1, step: 5 }))
  const aborted = reduceSessionEvent(b, ev('turn/end', { turn: 1, reason: { kind: 'aborted', reason: 'user' } }))
  assert.equal(aborted.snapshot.ok, false)
  assert.ok(aborted.snapshot.percent < 1)
})

test('无关注事件返回 changed=false 且不触碰状态', () => {
  const m = new ProgressMachine()
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  const before = m.snapshot()
  // 载荷刻意是合法形状：这样若将来有人误把某个事件类型接进进度通道，断言会因为
  // 「类型被识别」而失败，而不是因为载荷畸形而侥幸通过。
  // `approval/asked` / `approval/decided` 现已接入，单独覆盖，故不在此列。
  for (const t of ['user/message', 'assistant/message', 'request/context', 'plan/mode', '未来/未知']) {
    const r = reduceSessionEvent(m, ev(t, { turn: 1, step: 1, name: 'Bash', arguments: '{}' }))
    assert.equal(r.changed, false, `${t} 被误认为进度事件`)
  }
  assert.deepEqual(m.snapshot(), before)
})

test('tool/call 只设置当前任务标签，不碰百分比', () => {
  const m = new ProgressMachine()
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  const before = m.snapshot().percent
  const r = reduceSessionEvent(m, ev('tool/call', {
    turn: 1,
    step: 1,
    callId: 'c1',
    name: 'Bash',
    arguments: JSON.stringify({ command: 'pnpm test', description: '运行测试' }),
  }))
  assert.equal(r.changed, true)
  assert.equal(r.snapshot.currentTask, '运行测试')
  assert.equal(r.snapshot.percent, before, 'tool/call 不得改动进度')
  assert.equal(r.todoRatio, null)
})

test('tool/call 缺少可读工具名时不改动状态（changed=false）', () => {
  const m = new ProgressMachine()
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  const before = m.snapshot()
  for (const bad of [null, undefined, 42, {}, { name: '' }, { name: '   ' }]) {
    assert.doesNotThrow(() => reduceSessionEvent(m, ev('tool/call', bad)))
    const r = reduceSessionEvent(m, ev('tool/call', bad))
    assert.equal(r.changed, false)
  }
  assert.deepEqual(m.snapshot(), before)
})

test('todo/write 的 in_progress 项提供任务标签', () => {
  const m = new ProgressMachine()
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  const r = reduceSessionEvent(m, ev('todo/write', {
    todos: [
      { content: '写文档', status: 'completed' },
      { content: '修签名 bug', status: 'in_progress' },
      { content: '跑测试', status: 'pending' },
    ],
  }))
  assert.equal(r.snapshot.currentTask, '修签名 bug')
})

test('后到的 todo/write 覆盖先前的工具标签（todo 优先）', () => {
  const m = new ProgressMachine()
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  reduceSessionEvent(m, ev('tool/call', {
    turn: 1, step: 1, name: 'Bash', arguments: JSON.stringify({ command: 'ls' }),
  }))
  assert.equal(m.snapshot().currentTask, '执行命令：ls')
  const r = reduceSessionEvent(m, ev('todo/write', {
    todos: [{ content: '实现悬停标签', status: 'in_progress' }],
  }))
  assert.equal(r.snapshot.currentTask, '实现悬停标签')
})

test('新 turn 清空上一轮的任务标签，避免悬停时显示已结束的工作', () => {
  const m = new ProgressMachine()
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  reduceSessionEvent(m, ev('tool/call', {
    turn: 1, step: 1, name: 'Bash', arguments: JSON.stringify({ command: 'ls' }),
  }))
  assert.equal(m.snapshot().currentTask, '执行命令：ls')
  const r = reduceSessionEvent(m, ev('turn/start', { turn: 2 }))
  assert.equal(r.snapshot.currentTask, undefined)
})

test('task 字段对所有 snapshot 调用方都存在（含 reset）', () => {
  const m = new ProgressMachine()
  const keys = Object.keys(m.snapshot())
  for (const k of ['state', 'percent', 'mode', 'message', 'currentTask', 'turn', 'ok']) {
    assert.ok(keys.includes(k), `snapshot 缺少 ${k}`)
  }
  assert.equal(m.reset().currentTask, undefined)
})

test('事件重放（同一 turn/start 重复）不倒退', () => {
  const m = new ProgressMachine()
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  reduceSessionEvent(m, ev('step/end', { turn: 1, step: 20 }))
  const high = m.snapshot().percent
  const r = reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  assert.equal(r.snapshot.percent, high >= 0.05 ? high : 0.05)
})

test('turn/start 携带非法 turn 值不抛异常', () => {
  const m = new ProgressMachine()
  for (const bad of [null, 'x', undefined, {}, NaN]) {
    assert.doesNotThrow(() => reduceSessionEvent(m, ev('turn/start', { turn: bad })))
  }
})

// ---------------------------------------------------------------------------
// 审批挂起（approval/asked / approval/decided）
//
// 复现用户实测的 bug：等待审批时没有任何事件，120 秒后空闲看门狗收起了灵动岛，
// 而面板上正要显示批准入口。这两条是持久化审计事件，是判断"是否有人类决定在挂起"
// 的唯一准确信号。
// ---------------------------------------------------------------------------

test('approval/asked 标记为挂起，approval/decided 解除', () => {
  const m = new ProgressMachine()
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))

  const asked = reduceSessionEvent(m, ev('approval/asked', {
    id: 'req-1',
    toolName: 'bash',
    callId: 'call_1',
    reason: 'escalate sandbox',
  }))
  assert.equal(asked.changed, true)
  assert.equal(asked.snapshot.approvalPending, true)

  const decided = reduceSessionEvent(m, ev('approval/decided', { id: 'req-1', outcome: 'rejected' }))
  assert.equal(decided.changed, true)
  assert.equal(decided.snapshot.approvalPending, false)
})

test('审批挂起不改动百分比（它说明人在决策，不说明完成度）', () => {
  const m = new ProgressMachine()
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  const before = m.snapshot().percent
  reduceSessionEvent(m, ev('approval/asked', { id: 'r1', toolName: 'bash' }))
  assert.equal(m.snapshot().percent, before)
})

test('并发审批：多个 asked，只有全部 decided 才算解除', () => {
  const m = new ProgressMachine()
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  reduceSessionEvent(m, ev('approval/asked', { id: 'r1', toolName: 'bash' }))
  reduceSessionEvent(m, ev('approval/asked', { id: 'r2', toolName: 'bash' }))
  assert.equal(m.snapshot().approvalPending, true)

  reduceSessionEvent(m, ev('approval/decided', { id: 'r1', outcome: 'allowed-once' }))
  assert.equal(m.snapshot().approvalPending, true, '还有一个未决，不能提前解除')

  reduceSessionEvent(m, ev('approval/decided', { id: 'r2', outcome: 'rejected' }))
  assert.equal(m.snapshot().approvalPending, false)
})

test('未知 id 的 decided 不会把挂起错误地清掉', () => {
  const m = new ProgressMachine()
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  reduceSessionEvent(m, ev('approval/asked', { id: 'r1', toolName: 'bash' }))
  const r = reduceSessionEvent(m, ev('approval/decided', { id: 'never-asked', outcome: 'rejected' }))
  assert.equal(r.snapshot.approvalPending, true)
})

test('畸形审批载荷不抛异常，也不改动状态', () => {
  const m = new ProgressMachine()
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  const before = m.snapshot()
  for (const bad of [null, undefined, 42, 'x', {}, { id: 42 }, { id: '' }]) {
    assert.doesNotThrow(() => reduceSessionEvent(m, ev('approval/asked', bad)))
    assert.doesNotThrow(() => reduceSessionEvent(m, ev('approval/decided', bad)))
  }
  assert.deepEqual(m.snapshot(), before)
})

test('审批挂起时面板显示等待批准，而不是空白', () => {
  const m = new ProgressMachine()
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  reduceSessionEvent(m, ev('approval/asked', { id: 'r1', toolName: 'bash' }))
  assert.match(m.snapshot().currentTask ?? '', /等待批准/)
})

test('新 turn 清掉上一轮的挂起审批（不能永久卡住）', () => {
  const m = new ProgressMachine()
  reduceSessionEvent(m, ev('turn/start', { turn: 1 }))
  reduceSessionEvent(m, ev('approval/asked', { id: 'r1', toolName: 'bash' }))
  const r = reduceSessionEvent(m, ev('turn/start', { turn: 2 }))
  assert.equal(r.snapshot.approvalPending, false)
})
