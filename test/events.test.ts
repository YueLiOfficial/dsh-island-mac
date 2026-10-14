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

test('todo 加权公式：全部完成时必须恰为 1.0', () => {
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
  assert.equal(r.todoRatio, 1)
  assert.equal(r.snapshot.percent, 1)
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
  for (const t of ['user/message', 'assistant/message', 'tool/call', 'request/context', 'plan/mode', '未来/未知']) {
    const r = reduceSessionEvent(m, ev(t, { anything: true }))
    assert.equal(r.changed, false, `${t} 被误认为进度事件`)
  }
  assert.deepEqual(m.snapshot(), before)
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
