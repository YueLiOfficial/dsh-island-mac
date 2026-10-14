import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeMessage, decodeMessages, validateProgress } from '../src/protocol.ts'

test('编码产物不含裸换行（否则会撕裂 NDJSON 帧）', () => {
  const s = encodeMessage({ type: 'progress', percent: 0.5, mode: 'precise', message: '第一行\n第二行' })
  assert.ok(!s.includes('\n'), '编码结果含换行，会破坏分帧')
})

test('往返编解码', () => {
  const msg = { type: 'progress' as const, percent: 0.42, mode: 'estimated' as const }
  const { messages, rest } = decodeMessages(encodeMessage(msg) + '\n')
  assert.equal(rest, '')
  assert.deepEqual(messages[0], msg)
})

test('半包：不完整尾部作为 rest 返回且不解析', () => {
  const full = encodeMessage({ type: 'progress', percent: 0.3, mode: 'precise' })
  const half = full.slice(0, 10)
  const r = decodeMessages(half)
  assert.deepEqual(r.messages, [])
  assert.equal(r.rest, half)
})

test('粘包：一行内多个 JSON 全部解出', () => {
  const a = encodeMessage({ type: 'progress', percent: 0.1, mode: 'precise' })
  const b = encodeMessage({ type: 'bye' })
  const r = decodeMessages(`${a}\n${b}\n`)
  assert.equal(r.messages.length, 2)
  assert.equal(r.rest, '')
})

test('非 ASCII 中文往返不损坏（UTF-8 边界安全）', () => {
  const text = '正在编译 模块 ①✓'
  const r = decodeMessages(encodeMessage({ type: 'progress', percent: 0.5, mode: 'precise', message: text }) + '\n')
  assert.equal((r.messages[0] as any).message, text)
})

test('畸形 JSON 行被跳过而非抛出', () => {
  const good = encodeMessage({ type: 'bye' })
  assert.doesNotThrow(() => decodeMessages(`{bad json\n${good}\n`))
  const r = decodeMessages(`{bad json\n${good}\n`)
  assert.equal(r.messages.length, 1)
})

test('validateProgress clamp 越界值', () => {
  assert.deepEqual(validateProgress({ type: 'progress', percent: 5, mode: 'precise' }), { ok: true, percent: 1, mode: 'precise' })
  assert.deepEqual(validateProgress({ type: 'progress', percent: -3, mode: 'estimated' }), { ok: true, percent: 0, mode: 'estimated' })
})

test('validateProgress 拒绝非有限值与错误形状', () => {
  for (const bad of [
    { type: 'progress', percent: NaN, mode: 'precise' },
    { type: 'progress', percent: Infinity, mode: 'precise' },
    { type: 'progress', percent: '0.5', mode: 'precise' },
    { type: 'progress', percent: 0.5, mode: 'nope' },
    { type: 'progress', percent: 0.5 },
    { type: 'other', percent: 0.5, mode: 'precise' },
    null,
    42,
  ]) {
    const r = validateProgress(bad)
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 被错误接受`)
  }
})
