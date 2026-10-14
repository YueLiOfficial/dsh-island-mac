import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
// Importing this module is what makes `ctx.on('session/event', ...)` well-typed:
// dsh-session declaration-merges that event (and its `(session, event)`
// signature) into cordis' `Events` interface.
import '@deepseek-ai/dsh-session'
import Schema from '@deepseek-ai/schemastery'
import { ProgressMachine, type ProgressSnapshot } from './progress.ts'
import { reduceSessionEvent } from './events.ts'
import { encodeMessage, PROTOCOL_VERSION, type OutboundMessage } from './protocol.ts'
import { startHelper, type HelperHandle } from './helper.ts'
import { createProgressService, buildReportProgressTool, type IslandProgressService } from './tool.ts'
import { buildProgressInstruction } from './instructions.ts'

export const name = 'dynamic-island-progress'

/**
 * `systemPrompt` is required, not optional: `ctx.systemPrompt.section(...)` is
 * what tells the model when to call `report_progress`. Without it the tool is
 * registered but never invoked — dead code — and progress stays on the
 * heuristic forever.
 */
export const inject = ['tools', 'systemPrompt']

export interface Config {
  socketPath?: string
  helperPath?: string
  connectTimeoutMs?: number
  idleTimeoutMs?: number
  graceMs?: number
}

export const Config: Schema<Config> = Schema.object({
  socketPath: Schema.string().default(''),
  helperPath: Schema.string().default(''),
  connectTimeoutMs: Schema.number().default(10_000),
  idleTimeoutMs: Schema.number().default(120_000),
  graceMs: Schema.number().default(3_000),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    islandProgress: IslandProgressService
  }
}

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Default socket location: a private directory, never a world-writable one. */
export function defaultSocketPath(): string {
  return join(homedir(), 'Library', 'Application Support', 'dsh-island', 'island.sock')
}

/**
 * Default helper location. `bin/DynamicIslandBridge` is where the Swift build
 * puts the executable (see the Swift plan); `swift/...` is a development
 * fallback so a debug build works without an install step.
 */
export function defaultHelperPath(): string {
  return join(PACKAGE_ROOT, 'bin', 'DynamicIslandBridge')
}

/**
 * Assembles the plugin.
 *
 * Everything registered through `ctx` is disposed with the plugin. The one
 * thing `ctx` cannot manage is the child process, so it lives inside a single
 * `ctx.effect` whose async disposer is the only path that guarantees the
 * helper reaches a stopped state.
 */
export function apply(ctx: Context, config: Config): void {
  const socketPath = config.socketPath && config.socketPath.length > 0 ? config.socketPath : defaultSocketPath()
  const helperPath = config.helperPath && config.helperPath.length > 0 ? config.helperPath : defaultHelperPath()
  const connectTimeoutMs = config.connectTimeoutMs ?? 10_000
  const idleTimeoutMs = config.idleTimeoutMs ?? 120_000
  const graceMs = config.graceMs ?? 3_000

  const log = ctx.logger(name)
  const machine = new ProgressMachine()

  let handle: HelperHandle | null = null
  let disposed = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let reconnecting: Promise<void> | null = null

  const clearIdleTimer = (): void => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  /**
   * Coalesces progress into one frame per socket write. Rapid `step/end`
   * events would otherwise produce a burst of writes the helper cannot
   * usefully render.
   */
  let pending: ProgressSnapshot | null = null
  let flushing = false

  const flush = (): void => {
    if (pending === null || disposed) return
    const snapshot = pending
    pending = null
    if (snapshot.state === 'done') {
      send({ type: 'done', reason: snapshot.message ?? '', ok: snapshot.ok })
      return
    }
    if (snapshot.state === 'idle') {
      // Latent-trap guard. `bye` is sent DIRECTLY by the idle timer, not through
      // this queue, precisely so that resetting the machine to `idle` can never
      // swallow the message that collapses the island. If a future change
      // queues an idle snapshot instead, it must still reach the helper.
      send({ type: 'bye' })
      return
    }
    send({
      type: 'progress',
      percent: snapshot.percent,
      mode: snapshot.mode ?? 'estimated',
      ...(snapshot.message === undefined ? {} : { message: snapshot.message }),
    })
  }

  const scheduleFlush = (): void => {
    if (flushing) return
    flushing = true
    setTimeout(() => {
      flushing = false
      flush()
    }, 0)
  }

  const send = (message: OutboundMessage): void => {
    const sender = handle?.sender ?? null
    if (sender === null || !sender.alive) {
      // One reconnect attempt, driven by the write we were about to make. The
      // progress message is its own heartbeat, so there is no separate timer.
      void ensureSender().then((next) => {
        if (next === null) return
        try {
          next.send(encodeMessage(message))
          // Reset the idle clock on the reconnect path too, otherwise a task
          // that only ever sends after a reconnect would be collapsed by the
          // stale timer it inherited.
          bumpIdle()
        } catch {
          log.warn('island: send failed after reconnect')
        }
      })
      return
    }
    try {
      sender.send(encodeMessage(message))
      bumpIdle()
    } catch {
      log.warn('island: send failed')
    }
  }

  const bumpIdle = (): void => {
    clearIdleTimer()
    idleTimer = setTimeout(() => {
      // Nothing happened for a while: collapse the island rather than leaving
      // a stale bar on screen.
      send({ type: 'bye' })
      machine.reset()
    }, idleTimeoutMs)
    ;(idleTimer as { unref?: () => void }).unref?.()
  }

  /** Restarts the helper at most once per burst when the connection died. */
  const ensureSender = async (): Promise<HelperHandle['sender']> => {
    if (disposed) return null
    if (reconnecting !== null) {
      await reconnecting
      return handle?.sender ?? null
    }
    reconnecting = (async () => {
      await handle?.dispose()
      handle = null
      if (disposed) return
      handle = await startHelper({
        helperPath,
        socketPath,
        connectTimeoutMs,
        graceMs,
        onStderr: (line) => log.warn('island helper: %s', line),
      })
      if (handle.sender !== null) {
        handle.sender.send(encodeMessage({ type: 'hello', version: PROTOCOL_VERSION }))
      } else {
        log.warn(
          'island: helper not reachable at %s (binary: %s). ' +
            'Progress will not be displayed. Build it with the Swift layer, or set helperPath.',
          socketPath,
          helperPath,
        )
      }
    })()
    try {
      await reconnecting
    } finally {
      reconnecting = null
    }
    return handle?.sender ?? null
  }

  // --- Registration -------------------------------------------------------
  // ctx.provide / ctx.tools.register / ctx.systemPrompt.section / ctx.on are
  // all effect-scoped: they unregister with the plugin automatically.

  ctx.provide('islandProgress', createProgressService(machine, (snapshot) => {
    pending = snapshot
    scheduleFlush()
  }))

  ctx.tools.register(buildReportProgressTool(ctx.islandProgress))

  ctx.systemPrompt.section(buildProgressInstruction())

  ctx.on('session/event', (_session, event) => {
    if (disposed) return
    const result = reduceSessionEvent(machine, { type: event.type, data: event.data })
    if (!result.changed) return
    pending = result.snapshot
    scheduleFlush()
  })

  // --- Single effect owning the child process ------------------------------
  // All order-dependent teardown lives in ONE async disposer: multiple async
  // disposers run concurrently, so splitting "signal" from "await exit" across
  // two effects would leave orphans.
  ctx.effect(() => {
    const connection = (async () => {
      handle = await startHelper({
        helperPath,
        socketPath,
        connectTimeoutMs,
        graceMs,
        onStderr: (line) => log.warn('island helper: %s', line),
      })
      if (handle.sender !== null) {
        handle.sender.send(encodeMessage({ type: 'hello', version: PROTOCOL_VERSION }))
      } else {
        log.warn(
          'island: helper not reachable at %s (binary: %s). ' +
            'Progress will not be displayed. Build it with the Swift layer, or set helperPath.',
          socketPath,
          helperPath,
        )
      }
    })()

    return async () => {
      disposed = true
      // 1. Close our own registrations first so late events stay silent.
      clearIdleTimer()
      pending = null
      try {
        await connection
      } catch {
        /* startup already logged its reason */
      }
      // 2. `dispose` signals and then AWAITS quiescence, escalating if needed.
      await handle?.dispose()
      handle = null
    }
  }, `${name}: helper process`)
}
