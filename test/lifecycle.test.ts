import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, chmodSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHelper } from '../src/helper.ts'
import { HelperSupervisor } from '../src/supervisor.ts'

function scratch(): { dir: string; sock: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'island-lifecycle-'))
  chmodSync(dir, 0o700)
  return {
    dir,
    sock: join(dir, 'island.sock'),
    cleanup: () => {
      try {
        execFileSync('rm', ['-rf', dir])
      } catch {
        /* best effort */
      }
    },
  }
}

/**
 * True when a process matching `pattern` is alive.
 *
 * Only pgrep's exit status 1 ("no match") may be read as clean. Any other
 * failure — notably exit 2 for an ERE that fails to compile — must NOT be
 * treated as "no process", or this predicate silently becomes always-false
 * and the orphan tests pass forever.
 */
function processAlive(pattern: string): boolean {
  try {
    execFileSync('pgrep', ['-f', pattern], { stdio: 'pipe' })
    return true
  } catch (err) {
    const status = (err as { status?: number }).status
    if (status === 1) return false
    throw new Error(`pgrep exited ${String(status)}; cannot conclude "no process"`)
  }
}

function aliveByPid(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * A helper that ignores SIGTERM for `sigtermGraceMs`, then exits.
 *
 * Load-bearing: the stock fake exits ~2ms after SIGTERM, so an implementation
 * that merely *sends* the signal and returns still looks clean. A slow-to-die
 * helper makes "requested stop" and "awaited quiescence" observably different.
 */
function writeSlowHelper(dir: string, sigtermGraceMs: number): string {
  const path = join(dir, 'slow-helper.mjs')
  writeFileSync(
    path,
    [
      "import { createServer } from 'node:net'",
      "import { unlinkSync, existsSync } from 'node:fs'",
      'const socketPath = process.argv[2]',
      'if (existsSync(socketPath)) { try { unlinkSync(socketPath) } catch {} }',
      "createServer((s) => { s.on('error', () => {}); s.resume() }).listen(socketPath, () => {})",
      "process.on('SIGTERM', () => {",
      `  setTimeout(() => { try { unlinkSync(socketPath) } catch {}; process.exit(0) }, ${sigtermGraceMs})`,
      '})',
      '',
    ].join('\n'),
  )
  return path
}

test('dispose 会等待进程真正退出，而不是只发出 SIGTERM', async () => {
  const s = scratch()
  const slow = writeSlowHelper(s.dir, 800)
  const h = await startHelper({
    helperPath: process.execPath,
    helperArgs: [slow, s.sock],
    socketPath: s.sock,
    connectTimeoutMs: 8000,
    // Grace exceeds the helper's own delay so a correct dispose waits it out
    // rather than escalating — escalation would mask the defect.
    graceMs: 5000,
  })
  try {
    assert.ok(h.sender, '前置条件不成立：未连上 helper')
    assert.equal(typeof h.pid, 'number')
    const pid = h.pid!

    const started = Date.now()
    await h.dispose()
    const elapsed = Date.now() - started

    // Deliberately no sleep: a sleep is exactly what hides a
    // send-and-return implementation.
    assert.equal(aliveByPid(pid), false, `dispose 返回时进程 ${pid} 仍存活（只发了信号，没等停稳）`)
    assert.ok(elapsed >= 600, `dispose 仅耗时 ${elapsed}ms，说明它没有等待优雅退出`)
  } finally {
    s.cleanup()
  }
})

test('并发调用 dispose 时，每个调用返回的那一刻进程都已停稳', async () => {
  const s = scratch()
  const slow = writeSlowHelper(s.dir, 700)
  const h = await startHelper({
    helperPath: process.execPath,
    helperArgs: [slow, s.sock],
    socketPath: s.sock,
    connectTimeoutMs: 8000,
    graceMs: 5000,
  })
  try {
    assert.equal(typeof h.pid, 'number')
    const pid = h.pid!

    // Judge at the instant EACH call resolves. Checking only after every call
    // settles would hide the defect: the first call has already finished
    // killing the process by then.
    const observed: Array<{ call: number; aliveAtReturn: boolean; elapsed: number }> = []
    await Promise.all(
      [0, 1, 2].map(async (call) => {
        const started = Date.now()
        await h.dispose()
        observed.push({ call, aliveAtReturn: aliveByPid(pid), elapsed: Date.now() - started })
      }),
    )

    const early = observed.filter((o) => o.aliveAtReturn)
    assert.deepEqual(early, [], `有调用在进程仍存活时就返回了：${JSON.stringify(observed)}`)
  } finally {
    s.cleanup()
  }
})

test('undrained stdout 确实会阻塞写入者（F4 测试的机制前提）', async () => {
  const s = scratch()
  const writer = join(s.dir, 'writer.mjs')
  // writeSync(1) goes straight to the pipe; once full, the child blocks in
  // write(2). A synchronous process.stdout.write loop would NOT reproduce this
  // — those bytes only queue in the JS layer and never touch the pipe.
  writeFileSync(
    writer,
    [
      "import { writeSync } from 'node:fs'",
      'const chunk = Buffer.alloc(4096, 120)',
      'let written = 0',
      'for (let i = 0; i < 256; i++) { writeSync(1, chunk); written += chunk.length }',
      "writeSync(2, 'WROTE ' + written)",
      '',
    ].join('\n'),
  )

  const result = await new Promise<{ blocked: boolean; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [writer], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c: string) => {
      stderr += c
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ blocked: true, stderr })
    }, 3000)
    child.on('close', () => {
      clearTimeout(timer)
      resolve({ blocked: false, stderr })
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })

  try {
    assert.equal(
      result.blocked,
      true,
      `未复现阻塞（stderr=${result.stderr}）——F4 测试的机制前提不成立，它将无法证伪`,
    )
  } finally {
    s.cleanup()
  }
})

test('startHelper 会排空或忽略 stdout，使 helper 不会因写日志而卡死', async () => {
  const s = scratch()
  const loud = join(s.dir, 'loud-helper.mjs')
  writeFileSync(
    loud,
    [
      "import { createServer } from 'node:net'",
      "import { writeSync, unlinkSync, existsSync } from 'node:fs'",
      'const socketPath = process.argv[2]',
      'const chunk = Buffer.alloc(4096, 120)',
      // 1 MiB of blocking writes, then bind. Undrained, this never reaches listen().
      'for (let i = 0; i < 256; i++) writeSync(1, chunk)',
      'if (existsSync(socketPath)) { try { unlinkSync(socketPath) } catch {} }',
      "createServer((c) => { c.on('error', () => {}); c.resume() }).listen(socketPath, () => {})",
      "process.on('SIGTERM', () => process.exit(0))",
      '',
    ].join('\n'),
  )

  const h = await startHelper({
    helperPath: process.execPath,
    helperArgs: [loud, s.sock],
    socketPath: s.sock,
    connectTimeoutMs: 6000,
    graceMs: 2000,
  })
  try {
    assert.ok(h.sender, 'stdout 未被排空/忽略，helper 阻塞在 write(2) 上，未能 bind')
  } finally {
    await h.dispose()
    s.cleanup()
  }
})

// ---------------------------------------------------------------------------
// HelperSupervisor — the restart/teardown interleaving (the critical orphan path)
// ---------------------------------------------------------------------------

test('dispose 期间在途的 spawn 不会变成孤儿（F1 关键回归）', async () => {
  const s = scratch()
  const slowBind = join(s.dir, 'slow-bind.mjs')
  // Binds only after 2.5s, which holds the "child exists, handle not adopted"
  // window open long enough to dispose inside it.
  writeFileSync(
    slowBind,
    [
      "import { createServer } from 'node:net'",
      "import { unlinkSync, existsSync } from 'node:fs'",
      'const socketPath = process.argv[2]',
      'if (existsSync(socketPath)) { try { unlinkSync(socketPath) } catch {} }',
      'setTimeout(() => {',
      "  createServer((c) => { c.on('error', () => {}); c.resume() }).listen(socketPath, () => {})",
      "  process.on('SIGTERM', () => process.exit(0))",
      '}, 2500)',
      '',
    ].join('\n'),
  )

  const sup = new HelperSupervisor({
    helperPath: process.execPath,
    helperArgs: [slowBind, s.sock],
    socketPath: s.sock,
    connectTimeoutMs: 8000,
    graceMs: 5000,
  })

  const ensuring = sup.ensure().catch(() => null)
  await new Promise((r) => setTimeout(r, 300)) // child exists, not yet adopted
  await sup.dispose()
  await ensuring

  await new Promise((r) => setTimeout(r, 400))
  assert.equal(
    processAlive(`slow-bind\\.mjs.*${s.sock}`),
    false,
    'dispose 返回后仍有在途 spawn 产生的 helper 存活（孤儿）',
  )
  s.cleanup()
})

test('supervisor.dispose 并发调用时每个调用都等到停稳', async () => {
  const s = scratch()
  const slow = writeSlowHelper(s.dir, 700)
  const sup = new HelperSupervisor({
    helperPath: process.execPath,
    helperArgs: [slow, s.sock],
    socketPath: s.sock,
    connectTimeoutMs: 8000,
    graceMs: 5000,
  })

  await sup.ensure()
  const pid: number = (sup as unknown as { handle: { pid?: number } | null }).handle?.pid ?? 0
  assert.ok(pid > 0, '未取得 supervisor 持有的 helper pid')

  const observed: boolean[] = []
  await Promise.all([
    sup.dispose().then(() => observed.push(aliveByPid(pid))),
    sup.dispose().then(() => observed.push(aliveByPid(pid))),
  ])

  assert.deepEqual(observed.filter(Boolean), [], '有 supervisor.dispose 调用在进程存活时返回')
  s.cleanup()
})

test('socket 路径会作为最后一个参数传给 helper（否则非默认路径永远无法通信）', async () => {
  const s = scratch()
  const rec = join(s.dir, 'record-argv.mjs')
  writeFileSync(
    rec,
    [
      "import { writeFileSync, unlinkSync, existsSync } from 'node:fs'",
      "import { createServer } from 'node:net'",
      // argv 形态：真实 helper 是 [binary, socket]；用 node 当 helper 时是
      // [node, rec.mjs, socket]。两种情况下 socket 都是**最后一个**参数，
      // 所以断言最后一项，而不是写死下标 1。
      "writeFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv))",
      'const socketPath = process.argv.at(-1)',
      'if (existsSync(socketPath)) { try { unlinkSync(socketPath) } catch {} }',
      "createServer((c) => { c.on('error', () => {}); c.resume() }).listen(socketPath, () => {})",
      "process.on('SIGTERM', () => process.exit(0))",
      '',
    ].join('\n'),
  )
  const out = join(s.dir, 'argv.json')
  const prevOut = process.env.ARGV_OUT
  process.env.ARGV_OUT = out

  const sup = new HelperSupervisor({
    helperPath: process.execPath,
    helperArgs: [rec],
    socketPath: s.sock,
    connectTimeoutMs: 6000,
    graceMs: 2000,
  })
  try {
    const sender = await sup.ensure()
    assert.ok(sender, '前置条件不成立：helper 未启动（argv 未被记录）')
    assert.ok(existsSync(out), 'helper 未记录 argv')
    const argv: string[] = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(
      argv.at(-1),
      s.sock,
      `socket 路径不是最后一个参数，插件将永远无法与 helper 通信：${JSON.stringify(argv)}`,
    )
  } finally {
    await sup.dispose()
    if (prevOut === undefined) delete process.env.ARGV_OUT
    else process.env.ARGV_OUT = prevOut
    s.cleanup()
  }
})

test('抛异常的日志 sink 不会逃出 "never rejects" 契约', async () => {
  const s = scratch()
  const boom = (): never => {
    throw new Error('log sink exploded')
  }
  // 路径 1：spawn 同步抛（NUL 路径），且 onStderr 自身也抛
  const h1 = await startHelper({
    helperPath: 'bad\u0000path',
    socketPath: s.sock,
    connectTimeoutMs: 500,
    graceMs: 200,
    onStderr: boom,
  })
  assert.equal(h1.sender, null)
  await assert.doesNotReject(() => h1.dispose())

  // 路径 2：异步 ENOENT —— 抛异常发生在 ChildProcess 'error' 监听器内部，
  // 若不包裹会变成 uncaught exception 直接结束进程
  const h2 = await startHelper({
    helperPath: join(s.dir, 'definitely-missing-binary'),
    socketPath: s.sock,
    connectTimeoutMs: 600,
    graceMs: 200,
    onStderr: boom,
  })
  assert.equal(h2.sender, null)
  await assert.doesNotReject(() => h2.dispose())

  // 路径 3：onStdout sink 抛异常
  const h3 = await startHelper({
    helperPath: process.execPath,
    helperArgs: ['-e', 'process.stdout.write("noise"); setTimeout(()=>{},1500)'],
    socketPath: s.sock,
    connectTimeoutMs: 600,
    graceMs: 200,
    onStdout: boom,
  })
  await assert.doesNotReject(() => h3.dispose())

  s.cleanup()
})
