import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
// Importing this module is what makes `ctx.on('session/event', ...)` well-typed:
// dsh-session declaration-merges that event (and its `(session, event)`
// signature) into cordis' `Events` interface.
//
// Written as `import type {}` rather than a bare side-effect import on purpose:
// the augmentation is needed only by the type checker, while a bare import
// survives into the published JavaScript as a real runtime dependency on a package
// this bundle does not ship. Type-only, it is erased at emit.
import type {} from '@deepseek-ai/dsh-session'
import Schema from '@deepseek-ai/schemastery'
import { ProgressMachine, type ProgressSnapshot } from './progress.ts'
import { reduceSessionEvent } from './events.ts'
import { encodeMessage, PROTOCOL_VERSION, type OutboundMessage } from './protocol.ts'
import { HelperSupervisor } from './supervisor.ts'
import type { LineSender } from './transport.ts'
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
/**
 * Best-effort startup marker.
 *
 * The GUI writes no file logs, so "did apply() actually run?" is otherwise
 * unanswerable from outside the process — and an unresolved mount row fails
 * without producing anything observable. This file is the cheapest possible
 * positive evidence: if it exists with a timestamp newer than the app launch,
 * the plugin loaded and apply() ran.
 *
 * Never throws: a diagnostic must not be the reason a plugin fails to load.
 */
function writeStartupMarker(helperPath: string): void {
  try {
    const dir = join(homedir(), 'Library', 'Application Support', 'dsh-island')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(
      join(dir, 'plugin-applied.json'),
      `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, helperPath }, null, 2)}\n`,
    )
  } catch {
    /* diagnostics must never break loading */
  }
}

export function apply(ctx: Context, config: Config): void {
  const socketPath = config.socketPath && config.socketPath.length > 0 ? config.socketPath : defaultSocketPath()
  const helperPath = config.helperPath && config.helperPath.length > 0 ? config.helperPath : defaultHelperPath()
  const connectTimeoutMs = config.connectTimeoutMs ?? 10_000
  const idleTimeoutMs = config.idleTimeoutMs ?? 120_000
  const graceMs = config.graceMs ?? 3_000

  const log = ctx.logger(name)
  writeStartupMarker(helperPath)
  const machine = new ProgressMachine()

  // The supervisor owns the child process, including the restart/teardown
  // interleaving. Keeping that logic inline is what allowed an in-flight spawn
  // to escape teardown (a detached orphan that keeps rendering forever).
  const supervisor = new HelperSupervisor({
    helperPath,
    socketPath,
    connectTimeoutMs,
    graceMs,
    onStderr: (line) => log.warn('island helper: %s', line),
  })
  let disposed = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null

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
    const sender = supervisor.sender
    if (sender !== null && sender.alive) {
      try {
        sender.send(encodeMessage(message))
        bumpIdle()
        return
      } catch {
        log.warn('island: send failed')
      }
    }

    // One reconnect attempt, driven by the write we were about to make. The
    // progress message is its own heartbeat, so there is no separate timer.
    // `.catch` is mandatory: an unhandled rejection here terminates the whole
    // DSH process, and this runs from an event handler with no caller to catch it.
    void ensureSender()
      .then((next) => {
        if (next === null) {
          log.warn('island: no helper available; dropped %s', message.type)
          return
        }
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
      .catch((err: unknown) => {
        log.warn('island: reconnect failed: %s', String(err))
      })
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

  /**
   * Returns a live sender, restarting the helper once if needed.
   *
   * Delegates to the supervisor, which owns the restart/teardown interleaving
   * and guarantees that a spawn in flight when the plugin unloads is torn down
   * rather than orphaned. Never rejects.
   */
  const ensureSender = async (): Promise<LineSender | null> => {
    if (disposed) return null
    const sender = await supervisor.ensure()
    if (sender !== null) {
      try {
        sender.send(encodeMessage({ type: 'hello', version: PROTOCOL_VERSION }))
      } catch {
        /* the next send will reconnect */
      }
    } else if (!disposed) {
      log.warn(
        'island: helper not reachable at %s (binary: %s). ' +
          'Progress will not be displayed. Build it with the Swift layer, or set helperPath.',
        socketPath,
        helperPath,
      )
    }
    return sender
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
    // Kick off the first connect. `ensureSender` is the single entry point for
    // both startup and reconnect, so there is exactly one place that can spawn.
    // The `.catch` is defence in depth: `ensureSender` is documented never to
    // reject, but an unhandled rejection here would terminate the DSH session,
    // so the cost of the guard is nothing and the cost of being wrong is total.
    void ensureSender().catch((err: unknown) => {
      log.warn('island: initial helper start failed: %s', String(err))
    })

    return async () => {
      disposed = true
      // 1. Close our own registrations first so late events stay silent.
      clearIdleTimer()
      pending = null
      // 2. The supervisor awaits real quiescence: it waits for any spawn still
      //    in flight, stops the process, and escalates if SIGTERM is ignored.
      //    A disposer that only signalled would leave orphans.
      await supervisor.dispose()
    }
  }, `${name}: helper process`)
}
