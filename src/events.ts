import type { ProgressMachine, ProgressSnapshot } from './progress.ts'
import { ESTIMATE_CEILING } from './progress.ts'
import { currentTaskFromTodos, currentTaskFromToolCall } from './task.ts'

/**
 * The minimal shape this reducer needs from a durable session event.
 *
 * Deliberately structural rather than importing `SessionEvent` from
 * `@deepseek-ai/dsh-session`: the event names below are consumed at runtime
 * by `type`, and `todo/write` is not even in that package's `SessionEventMap`
 * (the `tool-todo` package adds it by declaration merging). Depending on the
 * type would make this module fail to compile against a build where the
 * merging package is absent.
 */
export interface SessionEventLike {
  type: string
  data: unknown
}

export interface ReductionResult {
  changed: boolean
  snapshot: ProgressSnapshot
  todoRatio: number | null
}

/** A `todo/write` item's status, per `@deepseek-ai/dsh-tool-todo`. */
type TodoStatus = 'pending' | 'in_progress' | 'completed'

/**
 * Weight given to an in-progress item. Chosen over plain `completed / total`
 * because that formula's entire signal is "nothing is done yet" — it cannot
 * tell "just started" from "about to finish the first item", and shows 0%
 * while the model is working at full tilt. See spec §4.1 for the comparison
 * table. Every completed-item ratio converges with this one, so the weighting
 * only affects the early phase. This is the single place the constant lives.
 */
const IN_PROGRESS_WEIGHT = 0.5

// ---------------------------------------------------------------------------
// Runtime shape guards
//
// Nothing below trusts the static type of `data`. Event payloads cross a
// persisted-log boundary and `SessionEventMap` is merge-extensible, so a
// malformed or future payload must degrade to "no operation", never a throw.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Reads `data.turn` as a number, or null when absent/malformed. */
function readTurn(data: unknown): number | null {
  if (!isRecord(data)) return null
  const turn = data.turn
  return typeof turn === 'number' && Number.isFinite(turn) ? turn : null
}

/** Reads `data.step` as a number, or null when absent/malformed. */
function readStep(data: unknown): number | null {
  if (!isRecord(data)) return null
  const step = data.step
  return typeof step === 'number' && Number.isFinite(step) ? step : null
}

/** Reads `data.name` (a `tool/call`'s tool name) as a string, or null. */
function readToolName(data: unknown): string | null {
  if (!isRecord(data)) return null
  const name = data.name
  return typeof name === 'string' && name.trim().length > 0 ? name : null
}

/**
 * Reads `data.arguments` — a `tool/call`'s UNPARSED arguments JSON string.
 *
 * Returned as-is: parsing belongs to `task.ts`, which owns the degradation rules
 * for model-produced JSON. A non-string becomes `undefined` rather than being
 * coerced, so a malformed payload yields the tool's generic label instead of a
 * bogus one.
 */
function readToolArguments(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined
  const args = data.arguments
  return typeof args === 'string' ? args : undefined
}

/**
 * Extracts the terminal reason kind. `turn/end` carries a `TurnEndReason`
 * discriminated union (`{ kind: 'completed', ... }`), but a bare string is
 * tolerated too so a shape change cannot silently turn every turn into a
 * failure.
 */
function readReasonKind(data: unknown): string | null {
  if (!isRecord(data)) return null
  const reason = data.reason
  if (typeof reason === 'string') return reason
  if (isRecord(reason) && typeof reason.kind === 'string') return reason.kind
  return null
}

/**
 * Computes the weighted todo ratio, or null when there is nothing to report.
 *
 * Returns null for an empty list and for a list where no entry has a readable
 * `status` — reporting either would mean asserting a progress value the data
 * does not support.
 */
function computeTodoRatio(data: unknown): number | null {
  if (!isRecord(data)) return null
  const todos = data.todos
  if (!Array.isArray(todos)) return null

  let completed = 0
  let inProgress = 0
  let total = 0

  for (const todo of todos) {
    if (!isRecord(todo)) continue
    const status = todo.status
    if (typeof status !== 'string') continue
    total += 1
    if (status === 'completed') completed += 1
    else if (status === 'in_progress') inProgress += 1
  }

  if (total === 0) return null
  return (completed + IN_PROGRESS_WEIGHT * inProgress) / total
}

// ---------------------------------------------------------------------------
// Per-event handlers
// ---------------------------------------------------------------------------

function onTurnStart(machine: ProgressMachine, data: unknown): ReductionResult {
  const turn = readTurn(data)
  // An unreadable turn must not start a phantom turn. Ignoring it also keeps
  // a malformed or replayed payload from wiping real progress.
  if (turn === null) return { changed: false, snapshot: machine.snapshot(), todoRatio: null }
  return { changed: true, snapshot: machine.startTurn(turn), todoRatio: null }
}

function onStepEnd(machine: ProgressMachine, data: unknown): ReductionResult {
  const step = readStep(data)
  if (step === null) return { changed: false, snapshot: machine.snapshot(), todoRatio: null }
  return { changed: true, snapshot: machine.onStep(step), todoRatio: null }
}

function onTurnEnd(machine: ProgressMachine, data: unknown): ReductionResult {
  const kind = readReasonKind(data)
  if (kind === null) return { changed: false, snapshot: machine.snapshot(), todoRatio: null }
  return { changed: true, snapshot: machine.endTurn(kind), todoRatio: null }
}

function onTodoWrite(machine: ProgressMachine, data: unknown): ReductionResult {
  const ratio = computeTodoRatio(data)
  // The label is read even when the ratio is unusable: a list whose statuses are
  // unreadable can still name the work in progress.
  const task = currentTaskFromTodos(data)
  if (ratio === null) {
    // Nothing trustworthy to report on the percentage: leave it exactly as it
    // was, but still take the label.
    if (task === null) return { changed: false, snapshot: machine.snapshot(), todoRatio: null }
    return { changed: true, snapshot: machine.setCurrentTask(task), todoRatio: null }
  }

  // A whole-list snapshot is a trustworthy ratio, so it locks the machine to
  // `precise` rather than being treated as a guess.
  //
  // The reported value is capped at ESTIMATE_CEILING: 100% must mean "this turn
  // ended", and a fully-ticked list does NOT mean that — the model often marks
  // every item complete and then keeps working (writing the summary, verifying).
  // Without this cap that tail showed 100% while the turn was still running, so
  // the number could not be read as "done". The ratio itself is still returned
  // verbatim in `todoRatio`, which is an observation about the list, not about
  // the display.
  const reported = Math.min(ESTIMATE_CEILING, ratio)
  if (task !== null) machine.setCurrentTask(task)
  const snapshot = machine.reportPrecise(reported, 'todo')
  return { changed: true, snapshot, todoRatio: ratio }
}

/**
 * A tool is starting. Only the label changes: the call tells us *what* is
 * happening, never how far along it is, so it must not touch the percentage.
 *
 * An unreadable name yields no label and therefore no state change at all, so a
 * malformed payload cannot force a pointless socket write.
 */
function onToolCall(machine: ProgressMachine, data: unknown): ReductionResult {
  const name = readToolName(data)
  if (name === null) return { changed: false, snapshot: machine.snapshot(), todoRatio: null }

  const task = currentTaskFromToolCall(name, readToolArguments(data))
  if (task === null) return { changed: false, snapshot: machine.snapshot(), todoRatio: null }
  return { changed: true, snapshot: machine.setCurrentTask(task), todoRatio: null }
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * Reduces one durable session event into progress-machine input.
 *
 * `turn/start`, `step/end`, `turn/end` and `todo/write` are **durable session
 * events**, not Cordis events — they can only be observed through
 * `ctx.on('session/event', ...)` and dispatched on `event.type`. Subscribing
 * `ctx.on('turn/start', ...)` would never fire (spec §4.1).
 *
 * The `default` branch is mandatory and must never become an `assertNever`:
 * `SessionEventMap` is merge-extensible, so a plugin may add event types this
 * build has never heard of.
 */
export function reduceSessionEvent(machine: ProgressMachine, event: SessionEventLike): ReductionResult {
  switch (event.type) {
    case 'turn/start':
      return onTurnStart(machine, event.data)
    case 'step/end':
      return onStepEnd(machine, event.data)
    case 'turn/end':
      return onTurnEnd(machine, event.data)
    case 'todo/write':
      return onTodoWrite(machine, event.data)
    case 'tool/call':
      return onToolCall(machine, event.data)
    default:
      // Not a progress anchor. Return without touching the machine so the
      // caller can skip an unnecessary socket write.
      return { changed: false, snapshot: machine.snapshot(), todoRatio: null }
  }
}
