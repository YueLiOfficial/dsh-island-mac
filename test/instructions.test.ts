import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildProgressInstruction, SYSTEM_PROMPT_SECTION_ORDER } from '../src/instructions.ts'
import { REPORT_PROGRESS_TOOL_NAME } from '../src/tool.ts'

test('段落形状满足 PromptSection 契约', () => {
  const s = buildProgressInstruction()
  assert.equal(typeof s.name, 'string')
  assert.ok(s.name.length > 0)
  assert.equal(typeof s.order, 'number')
  assert.ok(Number.isFinite(s.order), 'order 必须有限，否则注册会抛异常')
  assert.equal(typeof s.text, 'string')
  assert.ok((s.text as string).length > 0)
})

test('order 为 900（落在核心段落之后）', () => {
  assert.equal(buildProgressInstruction().order, 900)
})

test('name 带插件前缀，避免与其他插件同名段落冲突', () => {
  assert.ok(buildProgressInstruction().name.startsWith('dynamic-island-progress'))
})

test('文本提到工具名，模型才能把指令与工具对应起来', () => {
  assert.ok(buildProgressInstruction().text.includes(REPORT_PROGRESS_TOOL_NAME))
})

test('文本不鼓励每步都上报（避免噪声与与 todo 自动比例重复）', () => {
  const t = buildProgressInstruction().text
  // 必须表达"可选/仅在确知更准时"，而不是无条件调用
  assert.ok(/仅在/.test(t), '文本未说明这是可选覆盖')
})

test('文本不声称估算进度是精确的', () => {
  const t = buildProgressInstruction().text
  assert.ok(!/精确估算/.test(t), '不得暗示估算值精确')
})

test('order 在合理区间内（不与内置段落抢占）', () => {
  const o = buildProgressInstruction().order
  assert.ok(o > 0 && o < 10_000, `order=${o} 超出合理区间`)
})

test('常量与返回值一致（单点定义，防止两处漂移）', () => {
  assert.equal(buildProgressInstruction().order, SYSTEM_PROMPT_SECTION_ORDER)
})

test('文本明确 percent 是 0..1 小数而非百分数', () => {
  const t = buildProgressInstruction().text
  assert.ok(/\[0, 1\]/.test(t), '未说明 percent 的取值范围')
  assert.ok(/0\.5/.test(t), '未给出"一半用 0.5 而非 50"的正例')
})
