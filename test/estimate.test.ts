import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimatePercent } from '../src/estimate.ts'

test('已知取值符合 spec §4.2', () => {
  assert.equal(estimatePercent(0), 5)
  assert.equal(Math.round(estimatePercent(1)), 17)
  assert.equal(Math.round(estimatePercent(5)), 44)
  assert.equal(Math.round(estimatePercent(10)), 58)
  assert.equal(Math.round(estimatePercent(20)), 70)
})

test('永不越过 90 硬上限', () => {
  for (const s of [0, 1, 10, 100, 1e6, Number.MAX_SAFE_INTEGER]) {
    assert.ok(estimatePercent(s) <= 90, `step=${s} 越过 90`)
  }
})

test('单调不减', () => {
  let prev = -Infinity
  for (let s = 0; s < 500; s++) {
    const v = estimatePercent(s)
    assert.ok(v >= prev, `step=${s} 回退`)
    prev = v
  }
})

test('非法输入退化为下界而非 NaN', () => {
  assert.equal(estimatePercent(-5), 5)
  assert.equal(estimatePercent(NaN), 5)
  assert.equal(estimatePercent(Infinity), 90)
})
