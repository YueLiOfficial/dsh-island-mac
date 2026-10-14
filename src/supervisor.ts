import type { LineSender } from './transport.ts'
import { startHelper, type HelperHandle } from './helper.ts'

export interface SupervisorOptions {
  helperPath: string
  helperArgs?: string[]
  socketPath: string
  connectTimeoutMs: number
  graceMs: number
  onStderr?: (line: string) => void
}

/**
 * Owns the helper child process across restarts.
 *
 * Exists because restart and teardown are concurrent, and getting that
 * interleaving wrong leaks a detached process. Two properties it guarantees:
 *
 *  1. **No spawn escapes teardown.** A child exists from the moment `spawn`
 *     returns, but `startHelper` does not resolve until it has connected —
 *     up to `connectTimeoutMs` later. A disposer that only looks at the
 *     current handle during that window disposes nothing and leaves an
 *     orphan. Every spawn here is tagged with a token; if the supervisor was
 *     disposed while a spawn was in flight, the freshly created handle is
 *     torn down immediately instead of being adopted.
 *
 *  2. **Every `dispose()` caller awaits the same quiescence.** A boolean
 *     guard makes the second caller return instantly, which would let the
 *     plugin's disposer report completion while the helper is still alive.
 *     Here the second caller awaits the first caller's teardown promise.
 */
export class HelperSupervisor {
  private handle: HelperHandle | null = null
  private inFlight: Promise<void> | null = null
  private teardown: Promise<void> | null = null
  private disposed = false
  private readonly options: SupervisorOptions
  /** Bumped on every spawn so a stale in-flight spawn can detect dispose. */
  private token = 0

  // NOTE: no TypeScript parameter properties here. They are non-erasable
  // syntax, so `node` cannot run this file with type-stripping only
  // (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX). `erasableSyntaxOnly` in tsconfig
  // enforces this.
  constructor(options: SupervisorOptions) {
    this.options = options
  }

  get sender(): LineSender | null {
    return this.handle?.sender ?? null
  }

  /**
   * Returns a live sender, restarting the helper once if the current
   * connection is gone. Concurrent callers share one restart attempt.
   * Never rejects.
   */
  async ensure(): Promise<LineSender | null> {
    if (this.disposed) return null

    if (this.handle !== null && this.handle.sender !== null && this.handle.sender.alive) {
      return this.handle.sender
    }

    if (this.inFlight !== null) {
      await this.inFlight
      return this.disposed ? null : (this.handle?.sender ?? null)
    }

    const run = (async (): Promise<void> => {
      // Retire the previous process before replacing it.
      const previous = this.handle
      this.handle = null
      await previous?.dispose()
      if (this.disposed) return

      const token = ++this.token
      const handle = await startHelper({
        helperPath: this.options.helperPath,
        ...(this.options.helperArgs === undefined ? {} : { helperArgs: this.options.helperArgs }),
        socketPath: this.options.socketPath,
        connectTimeoutMs: this.options.connectTimeoutMs,
        graceMs: this.options.graceMs,
        ...(this.options.onStderr === undefined ? {} : { onStderr: this.options.onStderr }),
      })

      if (this.disposed || token !== this.token) {
        // Teardown began while this spawn was in flight. The child exists, so
        // it must be stopped here — nobody else holds a reference to it.
        await handle.dispose()
        return
      }

      this.handle = handle
    })()

    this.inFlight = run
    try {
      await run
    } finally {
      if (this.inFlight === run) this.inFlight = null
    }

    return this.disposed ? null : (this.handle?.sender ?? null)
  }

  /**
   * Stops the helper and waits until it is gone. Idempotent, and every
   * concurrent caller awaits the same completion.
   */
  async dispose(): Promise<void> {
    if (this.teardown !== null) return this.teardown

    this.disposed = true
    this.token += 1

    const pending = this.inFlight
    this.teardown = (async (): Promise<void> => {
      // Wait for an in-flight spawn first: it may still create a child that
      // only this method can stop.
      if (pending !== null) {
        try {
          await pending
        } catch {
          /* ensure() is non-throwing, but stay defensive */
        }
      }

      const handle = this.handle
      this.handle = null
      await handle?.dispose()
    })()

    return this.teardown
  }
}
