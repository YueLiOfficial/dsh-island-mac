import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { connectLineSender, type LineSender } from './transport.ts'

export interface HelperOptions {
  helperPath: string
  helperArgs?: string[]
  socketPath: string
  connectTimeoutMs: number
  /** How long to wait after SIGTERM before escalating to SIGKILL. */
  graceMs: number
  onStderr?: (line: string) => void
}

export interface HelperHandle {
  /** null when the helper could not be started or reached in time. */
  sender: LineSender | null
  /**
   * The helper's OS process id, or undefined when `spawn` failed outright.
   *
   * This is an explicit contract field, not an internal detail. A liveness
   * check must distinguish "process is gone" from "we never had a process":
   * `process.kill(undefined, 0)` throws, and a `catch` around it would report
   * a dead process for a spawn that never happened.
   */
  readonly pid?: number
  dispose(): Promise<void>
}

/**
 * Matches the credential-shaped environment names documented in the harness's
 * defensive-patterns rules. A spawned helper must not inherit keys it could
 * leak into its own logs or requests.
 */
const SECRET_ENV_RE = /(KEY|SECRET|TOKEN|PASSWORD)/i

export function scrubbedEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (SECRET_ENV_RE.test(key)) continue
    out[key] = value
  }
  return out
}

/**
 * Signals the child, preferring its whole process group.
 *
 * The helper is spawned detached, so a negative pid reaches the group. Falls
 * back to signalling the child alone when the group is already gone.
 */
function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    if (process.platform === 'win32') {
      child.kill(signal)
      return
    }
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      /* already gone */
    }
  }
}

/**
 * Starts the native helper and connects to it as a client.
 *
 * Never rejects. A missing binary (the common case before the Swift layer is
 * built) is a degraded state, not a plugin failure: the plugin loads, logs a
 * clear reason, and the rest of the harness keeps working. `sender` is null in
 * that case and the caller simply has nowhere to send progress.
 *
 * On return, the caller owns teardown: `dispose()` is the only thing that
 * guarantees the child reaches a stopped state.
 */
export async function startHelper(opts: HelperOptions): Promise<HelperHandle> {
  // The socket lives in a private directory so a predictable path cannot be
  // squatted or read by another user.
  const dir = dirname(opts.socketPath)
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
  } catch {
    // Best effort; a failure here surfaces later as a connect failure.
  }

  const child = spawn(opts.helperPath, opts.helperArgs ?? [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group on POSIX so teardown can signal the whole tree with
    // one negative-pid signal.
    detached: process.platform !== 'win32',
    env: scrubbedEnv(),
  })

  let exited = false
  const exitWaiters: Array<() => void> = []
  const markExited = (): void => {
    exited = true
    while (exitWaiters.length > 0) exitWaiters.pop()?.()
  }
  const waitForExit = (timeoutMs: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      if (exited) {
        resolve(true)
        return
      }
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        resolve(false)
      }, timeoutMs)
      ;(timer as { unref?: () => void }).unref?.()
      exitWaiters.push(() => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(true)
      })
    })

  // ENOENT and friends arrive here. Swallow the event: an unhandled 'error'
  // on a ChildProcess would crash the host process.
  child.on('error', (err: Error) => {
    opts.onStderr?.(`helper spawn failed: ${err.message}`)
    markExited()
  })
  child.on('close', markExited)

  if (child.stderr) {
    let buffer = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      buffer += chunk
      let newlineAt
      while ((newlineAt = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineAt)
        buffer = buffer.slice(newlineAt + 1)
        if (line.length > 0) opts.onStderr?.(line)
      }
    })
  }

  // Poll until the helper has bound. It needs a few hundred milliseconds, and
  // an immediate connect would race the bind.
  const deadline = Date.now() + opts.connectTimeoutMs
  let sender: LineSender | null = null
  let delay = 50
  while (Date.now() < deadline) {
    if (exited) break
    try {
      sender = await connectLineSender(opts.socketPath, {
        timeoutMs: Math.max(250, Math.min(1000, deadline - Date.now())),
      })
      break
    } catch {
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(250, Math.round(delay * 1.5))
    }
  }

  if (sender === null && !exited && child.pid !== undefined) {
    // Leave the process running: its stderr is the only diagnostic the user
    // has, and killing it here would hide the cause.
    opts.onStderr?.(`helper did not accept a connection within ${opts.connectTimeoutMs}ms`)
  }

  let disposed = false

  return {
    sender,
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true

      // 1. Close our registrations FIRST so late events stay silent.
      sender?.close()
      sender = null

      if (exited || child.pid === undefined) return

      // 2. Ask politely, reaching the whole group.
      signalTree(child, 'SIGTERM')
      if (await waitForExit(opts.graceMs)) return

      // 3. Escalate, then wait again. Returning after the signal alone would
      //    leave an orphan — teardown must reach quiescence, not just request
      //    it.
      signalTree(child, 'SIGKILL')
      await waitForExit(opts.graceMs)
    },
  }
}
