import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'

test('cordis Context 类型可导入且 on/effect 形状存在', () => {
  // 仅类型层面断言：若 Context 缺少 on 或 effect，tsc 会失败
  type HasOn = Context extends { on: (...a: never[]) => unknown } ? true : false
  type HasEffect = Context extends { effect: (...a: never[]) => unknown } ? true : false
  const ok: [HasOn, HasEffect] = [true, true]
  assert.deepEqual(ok, [true, true])
})
