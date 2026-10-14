import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProgressMachine } from '../src/progress.ts'
import { createProgressService, buildReportProgressTool } from '../src/tool.ts'

function harness() {
  const m = new ProgressMachine()
  m.startTurn(1)
  const published: number[] = []
  const service = createProgressService(m, (s) => published.push(s.percent))
  return { m, service, published }
}

test('service.report 切到 precise 并发布', () => {
  const { service, published } = harness()
  service.report(0.6, '一半')
  assert.equal(service.current().state, 'precise')
  assert.equal(service.current().percent, 0.6)
  assert.ok(published.length >= 1)
})

test('service.report clamp 越界与非有限值', () => {
  const { service } = harness()
  service.report(5)
  assert.equal(service.current().percent, 1)
  service.report(-2)
  assert.equal(service.current().percent, 1, '不应回退')
  service.report(NaN)
  assert.equal(service.current().percent, 1, 'NaN 不应改动状态')
})

test('超长 message 被截断而非无限增长', () => {
  const { service } = harness()
  service.report(0.5, 'x'.repeat(100_000))
  const msg = service.current().message ?? ''
  assert.ok(msg.length <= 200, `message 长度 ${msg.length} 未截断`)
})

test('service.current 返回快照副本，外部修改不影响内部', () => {
  const { service } = harness()
  service.report(0.5)
  const snap = service.current()
  snap.percent = 0.01
  assert.equal(service.current().percent, 0.5)
})

test('工具定义名称与 schema 符合约定', () => {
  const { service } = harness()
  const tool = buildReportProgressTool(service)
  assert.equal(tool.name, 'report_progress')
  assert.ok(tool.description.length > 0)
  assert.ok(tool.parameters, '缺少 parameters')
  assert.ok(tool.output, '缺少规范输出声明')
})

test('工具 execute 接受合法入参并返回规范值', async () => {
  const { service } = harness()
  const tool = buildReportProgressTool(service)
  const exec = { signal: new AbortController().signal } as any
  const value = await tool.execute({ percent: 0.75, message: 'ok' }, exec)
  assert.equal(service.current().percent, 0.75)
  assert.deepEqual(value, { ok: true })
})

test('工具 execute 对越界入参不抛异常且仍 clamp', async () => {
  const { service } = harness()
  const tool = buildReportProgressTool(service)
  const exec = { signal: new AbortController().signal } as any
  for (const p of [1e9, -1e9, 0]) {
    const v = await tool.execute({ percent: p, message: 'm' }, exec)
    assert.deepEqual(v, { ok: true })
  }
  assert.equal(service.current().percent, 1)
})
