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
  /**
   * Optional stdout sink, receiving RAW chunks (no `setEncoding` is applied).
   * Omit it and the child's stdout is `'ignore'`, which is the safe default:
   * an undrained pipe wedges a chatty helper.
   */
  onStdout?: (chunk: Buffer) => void
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
 * Wraps a log sink so a throwing sink cannot escape this module's
 * "never rejects / never throws" contract.
 *
 * A throw from the sink inside a stream listener surfaces as an uncaught
 * exception (exit 43), and inside the spawn continuation as an unhandled
 * rejection — either of which terminates the whole DSH process. Losing a log
 * line is strictly better than losing the user's session.
 */
function safeSink<T>(sink: ((value: T) => void) | undefined): (value: T) => void {
  return (value: T): void => {
    try {
      sink?.(value)
    } catch {
      /* a broken logger must not take the session down */
    }
  }
}

/**
 * Starts the native helper and connects to it as a client.
 *
 * Never rejects and never throws — not for a missing binary, not for a
 * malformed path, not for a throwing log sink. A missing binary (the common
 * case before the Swift layer is built) is a degraded state, not a plugin
 * failure: the plugin loads, logs a clear reason, and the rest of the harness
 * keeps working. `sender` is null in that case and the caller simply has
 * nowhere to send progress.
 *
 * On return, the caller owns teardown: `dispose()` is the only thing that
 * guarantees the child reaches a stopped state.
 */
export async function startHelper(opts: HelperOptions): Promise<HelperHandle> {
  const logErr = safeSink(opts.onStderr)
  const logOut = safeSink(opts.onStdout)

  // The socket lives in a private directory so a predictable path cannot be
  // squatted or read by another user.
  const dir = dirname(opts.socketPath)
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
  } catch {
    // Best effort; a failure here surfaces later as a connect failure.
  }

  // spawn can throw SYNCHRONOUSLY (e.g. ERR_INVALID_ARG_VALUE for an empty or
  // NUL-containing path), unlike the async ENOENT case. This function's
  // contract is "never rejects", so it must be caught here — a rejection would
  // surface as an unhandled rejection and terminate the user's DSH session.
  let child: ChildProcess
  try {
    child = spawn(opts.helperPath, opts.helperArgs ?? [], {
      // stdout is 'ignore' on purpose. A helper that writes to stdout (a log
      // line per frame, say) would otherwise fill the ~64KiB pipe buffer and
      // block in write(2), freezing progress with no log and no reconnect,
      // because the socket stays open. Give it an explicit sink if a caller
      // ever wants the bytes.
      stdio: ['ignore', opts.onStdout === undefined ? 'ignore' : 'pipe', 'pipe'],
      // Own process group on POSIX so teardown can signal the whole tree with
      // one negative-pid signal.
      detached: process.platform !== 'win32',
      env: scrubbedEnv(),
    })
  } catch (err) {
    logErr(`helper spawn threw: ${(err as Error).message}`)
    return {
      sender: null,
      async dispose(): Promise<void> {
        /* nothing was spawned */
      },
    }
  }

  if (child.stdout) {
    // No setEncoding: the sink is documented as receiving raw chunks.
    child.stdout.on('data', (chunk: Buffer) => logOut(chunk))
  }

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
    logErr(`helper spawn failed: ${err.message}`)
    // 'error' does NOT imply the process is gone (Node also emits it for a
    // failed kill), so it must not be treated as proof of exit on its own.
    // It does mean no 'close'/'exit' may ever arrive, so release waiters —
    // callers separately check `pid` for whether a process ever existed.
    markExited()
  })
  // Both events: 'close' waits for the stdio pipes to drain, so a grandchild
  // holding the write end would delay it past the process's real death.
  child.on('close', markExited)
  child.on('exit', markExited)

  if (child.stderr) {
    // Bounded: a helper that emits a large newline-free line must not be able
    // to grow this buffer without limit.
    let buffer = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      buffer += chunk
      let newlineAt
      while ((newlineAt = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineAt)
        buffer = buffer.slice(newlineAt + 1)
        if (line.length > 0) logErr(line)
      }
      if (buffer.length > 8192) {
        logErr(`${buffer.slice(0, 8192)}…[truncated]`)
        buffer = ''
      }
    })
    // Flush a trailing partial line so the last diagnostic is not lost.
    child.stderr.on('end', () => {
      if (buffer.length > 0) {
        logErr(buffer)
        buffer = ''
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
    logErr(`helper did not accept a connection within ${opts.connectTimeoutMs}ms`)
  }

  let teardown: Promise<void> | null = null

  return {
    sender,
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    dispose(): Promise<void> {
      // A plain boolean guard would let a second concurrent caller return
      // immediately — before quiescence — so the plugin's single disposer could
      // report completion while the helper is still alive. Every caller awaits
      // the same teardown instead.
      if (teardown !== null) return teardown

      teardown = (async (): Promise<void> => {
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
        if (!(await waitForExit(opts.graceMs))) {
          // Report rather than silently claim success: a process that survives
          // SIGKILL for a full grace period is a fact the operator needs.
          logErr(
            `helper pid ${String(child.pid)} did not exit within ${opts.graceMs}ms after SIGKILL`,
          )
        }
      })()

      return teardown
    },
  }
}
