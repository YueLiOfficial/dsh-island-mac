import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, existsSync, rmSync, chmodSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startHelper } from '../src/helper.ts'

// 必须用 fileURLToPath 而非 .pathname：工作区路径含空格（"Dynamic Island for mac"），
// .pathname 会返回百分号编码的 /Dynamic%20Island%20... 导致 spawn 找不到文件。
const FAKE = fileURLToPath(new URL('../scripts/fake-helper.mjs', import.meta.url))

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'island-test-'))
  chmodSync(dir, 0o700)
  return { dir, sock: join(dir, 'island.sock'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('spawn 假 helper 后能连上并发送一行', async () => {
  const s = scratch()
  const h = await startHelper({ helperPath: process.execPath, helperArgs: [FAKE, s.sock], socketPath: s.sock, connectTimeoutMs: 8000, graceMs: 2000 })
  try {
    assert.ok(h.sender, '未能建立连接')
    h.sender!.send(JSON.stringify({ type: 'progress', percent: 0.5, mode: 'precise' }))
  } finally {
    await h.dispose()
    s.cleanup()
  }
})

test('dispose 之后进程确实已退出（无孤儿）', async () => {
  const s = scratch()
  const h = await startHelper({ helperPath: process.execPath, helperArgs: [FAKE, s.sock], socketPath: s.sock, connectTimeoutMs: 8000, graceMs: 2000 })
  // pid 是 HelperHandle 的显式契约字段（见 Interfaces 的 pid?: number）。
  // 不可用 `(h as any).pid` 绕过类型——那样 pid 恒为 undefined，
  // process.kill(undefined, 0) 抛 TypeError 被 catch 吞掉，测试会永远假通过。
  assert.equal(typeof h.pid, 'number', 'spawn 成功后 HelperHandle.pid 必须是有效 number')
  const pid = h.pid!
  await h.dispose()
  await new Promise((r) => setTimeout(r, 300))
  let alive = true
  try { process.kill(pid, 0) } catch { alive = false }
  assert.equal(alive, false, `dispose 后进程 ${pid} 仍存活（孤儿）`)
  s.cleanup()
})

test('扫真实进程表确认无遗留 helper（覆盖派生进程，非仅 pid 存活判定）', async () => {
  const s = scratch()
  const marker = s.sock   // 唯一路径，pgrep 不会撞到其他并发测试
  const h = await startHelper({
    helperPath: process.execPath, helperArgs: [FAKE, marker],
    socketPath: marker, connectTimeoutMs: 8000, graceMs: 2000,
  })
  try {
    assert.ok(h.sender, '前置条件不成立：未连上 helper')
  } finally {
    await h.dispose()
  }
  // 只在测试仍在运行时检查：s.cleanup() 之后跑会误读为「无泄漏」，
  // 反而掩盖 dispose 的缺陷。
  await new Promise((r) => setTimeout(r, 200))
  let leaked = false
  try {
    // pgrep 匹配命令行：fake-helper.mjs 后紧跟这个唯一 socket 路径。
    // -f 匹配完整命令行；socket 路径含 @ 和 - 不含正则元字符。
    execFileSync('pgrep', ['-f', `fake-helper\\.mjs.*${marker}`], { stdio: 'pipe' })
    leaked = true
  } catch (err) {
    const status = (err as { status?: number }).status
    if (status !== 1) {
      // 只有退出码 1 才表示「无匹配」。退出码 2 是 ERE 编译失败
      // （例如 TMPDIR 含正则元字符），把它当成「干净」会让本测试永远假通过。
      throw new Error(`pgrep exited ${String(status)}; cannot conclude "no process"`)
    }
    leaked = false
  }
  s.cleanup()
  assert.equal(leaked, false, '进程表中仍有 fake-helper，dispose 未达到完全停稳')
})

test('dispose 是幂等的，重复调用不抛异常', async () => {
  const s = scratch()
  const h = await startHelper({ helperPath: process.execPath, helperArgs: [FAKE, s.sock], socketPath: s.sock, connectTimeoutMs: 8000, graceMs: 2000 })
  await h.dispose()
  await assert.doesNotReject(() => h.dispose())
  s.cleanup()
})

test('helper 二进制不存在时优雅降级，不抛未捕获异常', async () => {
  const s = scratch()
  const h = await startHelper({ helperPath: '/nonexistent/definitely-not-here', helperArgs: [], socketPath: s.sock, connectTimeoutMs: 1500, graceMs: 500 })
  assert.equal(h.sender, null, '二进制缺失时不应报告已连接')
  await assert.doesNotReject(() => h.dispose())
  s.cleanup()
})

test('连接成功后 socket 文件存在且权限不含 group/other 写', async () => {
  const s = scratch()
  const h = await startHelper({ helperPath: process.execPath, helperArgs: [FAKE, s.sock], socketPath: s.sock, connectTimeoutMs: 8000, graceMs: 2000 })
  try {
    assert.ok(existsSync(s.sock), 'socket 文件未创建')
  } finally {
    await h.dispose()
    s.cleanup()
  }
})

test('helper 缺少可执行位时（pnpm pack 会丢掉它）插件在 spawn 前补回来', async () => {
  // `npm pack` 保留文件的 0755，`pnpm pack`（以及 `pnpm publish`）写成 0644。
  // 从这种 tarball 装出来的 helper 会以 EACCES 启动失败，症状与「二进制不存在」
  // 完全一样——插件日志只会说 helper not reachable。所以插件自己补这一位。
  const s = scratch()
  const shim = join(s.dir, 'helper.sh')
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`)
  chmodSync(shim, 0o644)
  assert.equal(statSync(shim).mode & 0o111, 0, '前提：起点确实没有可执行位')

  const h = await startHelper({
    helperPath: shim,
    // startHelper 不会追加 socket 路径（那是 supervisor 的职责），所以这里显式传。
    helperArgs: [s.sock],
    socketPath: s.sock,
    connectTimeoutMs: 8000,
    graceMs: 2000,
  })
  try {
    assert.notEqual(h.sender, null, 'helper 因为缺少可执行位而没能启动')
    assert.notEqual(statSync(shim).mode & 0o100, 0, '插件应在 spawn 之前补上可执行位')
  } finally {
    await h.dispose()
    s.cleanup()
  }
})

test('已经可执行的 helper 不被改动权限', async () => {
  // 补位的实现必须先看权限位再 chmod：无脑 chmod 会去改 /usr/bin/node 这类
  // 别人的文件（测试里 helperPath 常常就是它）。
  const s = scratch()
  const shim = join(s.dir, 'helper.sh')
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`)
  chmodSync(shim, 0o744)
  const before = statSync(shim).mode

  const h = await startHelper({
    helperPath: shim,
    helperArgs: [s.sock],
    socketPath: s.sock,
    connectTimeoutMs: 8000,
    graceMs: 2000,
  })
  try {
    assert.equal(statSync(shim).mode, before, '已经可执行的文件不该被改权限')
  } finally {
    await h.dispose()
    s.cleanup()
  }
})
