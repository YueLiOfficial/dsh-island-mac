import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProgressMachine } from '../src/progress.ts'

test('不变式1: estimated → precise 单向，precise 不回落', () => {
  const m = new ProgressMachine()
  m.startTurn(1)
  m.reportPrecise(0.5, 'half')
  assert.equal(m.snapshot().state, 'precise')
  m.onStep(99) // 估算值更高
  assert.equal(m.snapshot().state, 'precise')
  assert.equal(m.snapshot().mode, 'precise')
  assert.equal(m.snapshot().percent, 0.5)
})

test('不变式2: 显示值单调不减（含 step 回退与重放）', () => {
  const m = new ProgressMachine()
  m.startTurn(1)
  const seen: number[] = []
  for (const s of [0, 1, 5, 3, 2, 10, 1, 20]) {
    seen.push(m.onStep(s).percent)
  }
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i]! >= seen[i - 1]!, `回退 at ${i}: ${seen.join(',')}`)
  }
})

test('不变式3: precise 后 heuristic 不拉低显示值', () => {
  const m = new ProgressMachine()
  m.startTurn(1)
  m.onStep(50)             // 估算到 ~88
  m.reportPrecise(0.95, 'x')
  const after = m.onStep(0).percent   // 估算值远低
  assert.equal(after, 0.95)
})

test('不变式4: 空闲超时由调用方驱动，机器本身只暴露 reset', () => {
  const m = new ProgressMachine()
  m.startTurn(1)
  assert.equal(m.snapshot().state, 'estimated')
  m.reset()
  assert.equal(m.snapshot().state, 'idle')
  assert.equal(m.snapshot().percent, 0)
})

test('估算阶段永不声称 100%', () => {
  const m = new ProgressMachine()
  m.startTurn(1)
  for (let s = 0; s < 1000; s += 7) {
    const p = m.onStep(s).percent
    assert.ok(p <= 0.9, `估算给出 ${p} > 0.9`)
  }
})

test('turn/end completed → 100 且 ok=true', () => {
  const m = new ProgressMachine()
  m.startTurn(1)
  m.onStep(3)
  const s = m.endTurn('completed')
  assert.equal(s.percent, 1)
  assert.equal(s.ok, true)
  assert.equal(s.state, 'done')
})

test('异常终态不显示 100% 且 ok=false', () => {
  for (const kind of ['aborted', 'error', 'interrupted', 'max-tokens', 'blocked']) {
    const m = new ProgressMachine()
    m.startTurn(1)
    m.onStep(5)
    const before = m.snapshot().percent
    const s = m.endTurn(kind)
    assert.equal(s.ok, false, `${kind} 被判为成功`)
    assert.ok(s.percent < 1, `${kind} 显示了 100%`)
    assert.equal(s.percent, before)
  }
})

test('未知 turn/end reason 不得抛异常（TurnEndReasonMap 可扩展）', () => {
  const m = new ProgressMachine()
  m.startTurn(1)
  const s = m.endTurn('some-future-reason')
  assert.equal(s.ok, false)
})

test('新 turn 重置百分比仍保持单调（跨 turn 不倒退）', () => {
  const m = new ProgressMachine()
  m.startTurn(1)
  m.onStep(20)
  const high = m.snapshot().percent
  m.endTurn('completed')
  const s = m.startTurn(2)
  assert.ok(s.percent <= high, '新 turn 不应超过上一 turn 的终值')
  assert.equal(s.percent, 0.05)
})
