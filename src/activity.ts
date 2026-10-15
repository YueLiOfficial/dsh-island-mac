/**
 * Reducers for the activity events that drive the island's label and liveness.
 *
 * Two very different event buses feed this module, and confusing them is the
 * main hazard:
 *
 * 1. **`session/event`** — durable session-log events (`tool/call`, `todo/write`,
 *    …). Consumed in `events.ts`, not here.
 * 2. **Cordis events** — `session/created`, `session/disposed`, `tools/pre-execute`,
 *    `tools/post-execute`, `subagent/start`, `subagent/end`, `agent/status`.
 *    Their payloads differ per event, so each has its own signature below.
 *
 * **None of these seven carry a completion fraction.** They say what is happening
 * and whether work is still alive; they never say how much is done. So nothing in
 * this file may touch `percent` — completion stays with the todo ratio and the
 * step estimator. What they legitimately drive is the task label and the idle
 * watchdog (see `src/index.ts`).
 */

import type { ProgressMachine, ProgressSnapshot } from './progress.ts'
import { currentTaskFromToolCall } from './task.ts'

/** What a reducer concluded. Mirrors the shape used in `events.ts`. */
export interface ActivityResult {
  /** Whether anything the user can see changed. Drives the throttled flush. */
  changed: boolean
  snapshot: ProgressSnapshot
  /**
   * Whether this event proves work is still in progress.
   *
   * Read by the caller to keep the session alive through long tool calls, which
   * emit nothing for minutes at a time.
   */
  activity?: boolean
}

const noChange = (machine: ProgressMachine): ActivityResult => ({
  changed: false,
  snapshot: machine.snapshot(),
})

// ---------------------------------------------------------------------------
// Shape guards
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Reads a non-empty string field, or null.
 *
 * Everything here crosses a plugin boundary, so payloads are validated at
 * runtime rather than trusted: `SessionEventMap` and the Cordis event map are
 * both merge-extensible, and another plugin's shapes are not ours to assume.
 */
function readString(source: unknown, key: string): string | null {
  if (!isRecord(source)) return null
  const value = source[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

/** Identifies an agent's session, whichever event supplied it. */
export function sessionIdOf(source: unknown): string | null {
  if (!isRecord(source)) return null
  const session = source.session
  if (isRecord(session)) return readString(session, 'id')
  // `tools/*` instead carry the agent; read through to its session.
  const agent = source.agent
  if (isRecord(agent)) return sessionIdOf(agent)
  return null
}

/** Our own session, whose events we act on. Null until `session/created`. */
let trackedSession: string | null = null

/** Test seam: forget which session is tracked. */
export function resetTrackedSession(): void {
  trackedSession = null
}

/** Whether an event belongs to the session this plugin is displaying for. */
function isOurSession(source: unknown): boolean {
  const id = sessionIdOf(source)
  return id !== null && id === trackedSession
}

// ---------------------------------------------------------------------------
// Notification events
// ---------------------------------------------------------------------------

/**
 * `session/created` `(session)`.
 *
 * The first session wins and later ones are ignored. Acting on every session
 * would let a subagent's session hijack the island away from the user's.
 * `session/disposed` clears the tracking, so a genuinely new session is adopted.
 */
export function onSessionCreated(machine: ProgressMachine, session: unknown): ActivityResult {
  const id = sessionIdOf(session)
  if (id === null) return noChange(machine)
  if (trackedSession !== null) return noChange(machine)

  trackedSession = id
  // A session existing is not, by itself, something to show: an empty session
  // would flash the island before any work happens. Only the bookmark changes.
  return { changed: false, snapshot: machine.snapshot(), activity: true }
}

/**
 * `session/disposed` `(session)`.
 *
 * Only reacts to our own session: another session ending must not retract a bar
 * that is tracking ours.
 */
export function onSessionDisposed(machine: ProgressMachine, session: unknown): ActivityResult {
  if (!isOurSession(session)) return noChange(machine)
  trackedSession = null
  return { changed: true, snapshot: machine.reset(), activity: true }
}

/**
 * `agent/status` `({ agent, status })`.
 *
 * Deliberately the ONLY effect is liveness. `status === 'running'` is the sole
 * signal that distinguishes "a long tool call is in flight" from "this session
 * was abandoned", and the idle watchdog needs exactly that distinction to avoid
 * collapsing the island mid-task. It is never shown as text.
 */
export function onAgentStatus(machine: ProgressMachine, payload: unknown): ActivityResult {
  if (!isOurSession(payload)) return noChange(machine)
  const status = readString(payload, 'status')
  if (status === null) return noChange(machine)

  const wasRunning = machine.snapshot().agentRunning
  const running = status === 'running'
  if (running === wasRunning) return noChange(machine)
  return { changed: true, snapshot: machine.setAgentRunning(running), activity: running }
}

/**
 * `subagent/start` `(info)` — a notification, returning nothing.
 *
 * `runId` is the stable key; `end` matches on it so overlapping subagents cannot
 * decrement each other's entry.
 */
export function onSubagentStart(machine: ProgressMachine, info: unknown): ActivityResult {
  const runId = readString(info, 'runId')
  if (runId === null) return noChange(machine)

  const before = machine.snapshot().subagentCount
  const snapshot = machine.subagentStarted(runId)
  return { changed: snapshot.subagentCount !== before, snapshot, activity: true }
}

export function onSubagentEnd(machine: ProgressMachine, info: unknown): ActivityResult {
  const runId = readString(info, 'runId')
  if (runId === null) return noChange(machine)

  const before = machine.snapshot().subagentCount
  const snapshot = machine.subagentFinished(runId)
  return { changed: snapshot.subagentCount !== before, snapshot, activity: true }
}

// ---------------------------------------------------------------------------
// Cordis event dispatcher for the notifications
// ---------------------------------------------------------------------------

/**
 * Pure dispatcher for the two session-lifecycle and two subagent notifications.
 *
 * `tools/*` are NOT here: they are middleware and need the `next` continuation,
 * so they have dedicated handlers below. Keeping them out is deliberate — a
 * generic dispatcher cannot express "must call next()".
 */
export function reduceActivityEvent(
  machine: ProgressMachine,
  type: string,
  payload: unknown,
): ActivityResult {
  switch (type) {
    case 'session/created':
      return onSessionCreated(machine, payload)
    case 'session/disposed':
      return onSessionDisposed(machine, payload)
    case 'agent/status':
      return onAgentStatus(machine, payload)
    case 'subagent/start':
      return onSubagentStart(machine, payload)
    case 'subagent/end':
      return onSubagentEnd(machine, payload)
    default:
      // Merge-extensible event map: an unknown type must degrade to "no
      // operation", never throw.
      return noChange(machine)
  }
}

// ---------------------------------------------------------------------------
// Tool middleware
// ---------------------------------------------------------------------------

/** Shape of the `exec` an `tools/pre-execute` handler receives. */
export interface ToolExecLike {
  callId?: unknown
  name?: unknown
  arguments?: unknown
  agent?: unknown
}

/**
 * State change for `tools/pre-execute` — label only.
 *
 * Percent is untouched: a tool starting says what is happening, not how far
 * along it is.
 */
export function onToolPreExecute(machine: ProgressMachine, exec: ToolExecLike): ActivityResult {
  const name = readString(exec, 'name')
  if (name === null) return noChange(machine)

  const callId = readString(exec, 'callId') ?? name
  const label = currentTaskFromToolCall(name, exec.arguments) ?? name

  const before = machine.snapshot().currentTask
  const snapshot = machine.toolStarted(callId, label)
  return { changed: snapshot.currentTask !== before, snapshot, activity: true }
}

/**
 * State change for `tools/post-execute` — drop that call from the in-flight set.
 *
 * An unknown `callId` is a no-op, which is what keeps a todo-derived label alive
 * across the post-execute of whatever tool preceded it.
 *
 * `result` is accepted but unused: it carries no completion fraction, and
 * inferring one from tool output is exactly the kind of guess this plugin
 * refuses to make.
 */
export function onToolPostExecute(
  machine: ProgressMachine,
  exec: ToolExecLike,
  _result?: unknown,
): ActivityResult {
  // Must mirror `onToolPreExecute`'s fallback exactly. If `pre` keyed on the tool
  // name (no `callId` supplied) and `post` then bailed on the missing `callId`,
  // that tool's label would stick forever — a stuck "current task" is worse than
  // no label at all, because it is confidently wrong.
  const name = readString(exec, 'name')
  const callId = readString(exec, 'callId') ?? name
  if (callId === null) return noChange(machine)

  const before = machine.snapshot().currentTask
  const snapshot = machine.toolFinished(callId)
  return { changed: snapshot.currentTask !== before, snapshot, activity: true }
}
