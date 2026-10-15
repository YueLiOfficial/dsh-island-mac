import { estimatePercent } from './estimate.ts'

/**
 * Progress source. `estimated` derives from step counts; `precise` comes from
 * an explicit report (the `report_progress` tool) or from a trustworthy
 * whole-list ratio (`todo/write`).
 */
export type ProgressMode = 'estimated' | 'precise'

export type ProgressState = 'idle' | 'estimated' | 'precise' | 'done'

export interface ProgressSnapshot {
  state: ProgressState
  /** Fraction in [0, 1]. */
  percent: number
  mode: ProgressMode | null
  message: string | undefined
  /**
   * Short human-readable description of what is happening right now, shown in
   * the expanded (hover) panel. Distinct from `message`: that one is a status
   * line the model or a terminal signal supplied, while this is derived from the
   * event stream and changes as work moves on.
   */
  currentTask: string | undefined
  /**
   * Whether an agent is currently running, as told by `agent/status`.
   *
   * This is the only signal that says "work is alive but nothing is being
   * emitted" — a long tool call, or waiting on a human. The idle watchdog reads
   * it so a busy session is not collapsed mid-task (see `src/index.ts`).
   */
  agentRunning: boolean
  /** How many subagents are running right now. Displayed as a suffix. */
  subagentCount: number
  /**
   * Whether an `approval/asked` is still waiting for its `approval/decided`.
   *
   * This is the ONE signal that distinguishes "a human is being asked to decide"
   * from "nothing is happening": during an approval wait the event stream is
   * genuinely silent, so every activity-based heuristic reads as idle. Verified
   * against a real session — a multi-minute approval wait let the idle watchdog
   * collapse the island exactly when the user needed it on screen.
   *
   * An id SET rather than a boolean internally, because approvals can overlap and
   * only the last `decided` should release the hold.
   */
  approvalPending: boolean
  turn: number | null
  ok: boolean
}

/** Fraction at which a new turn starts. Matches spec §4.3. */
const TURN_START_PERCENT = 0.05

/**
 * Hard ceiling for the estimate layer, as a fraction. The estimator itself
 * caps at 90%; this re-asserts it so no future estimator change can let an
 * estimate claim completion.
 *
 * Exported because it is also the ceiling for a whole-list todo ratio: 100% must
 * mean "the turn ended", and a fully-ticked todo list is not that. Keeping one
 * constant for both keeps the two paths from drifting apart.
 */
export const ESTIMATE_CEILING = 0.9

/**
 * Pseudo call id for the todo-derived label.
 *
 * It lives in the same in-flight stack as tool labels so both participate in one
 * priority order, but it has no real `tools/post-execute` to remove it. A
 * distinctive value guarantees no tool's `callId` can accidentally clear it.
 */
const TODO_LABEL_ID = 'todo:in-progress'

/** A tool call that has started but not yet finished. */
interface InFlightTool {
  callId: string
  label: string
}

/**
 * The single source of truth for displayed progress.
 *
 * Invariants (spec §4.3):
 *  1. `estimated → precise` is one-way; `precise` never falls back.
 *  2. The displayed value is monotonically non-decreasing within a turn.
 *     The only exception is a `completed` turn, which jumps to 100%.
 *  3. A precise value is never pulled down by a later heuristic estimate.
 *  4. Idle timeout is driven by the caller; the machine only exposes `reset`.
 *
 * `startTurn` is the ONE explicit reset point. Monotonicity is a within-turn
 * guarantee, not a cross-turn one — a new turn legitimately restarts at 5%.
 * Deliberately NOT implemented: allowing a precise source's value to fall.
 * A single source being allowed to move backwards makes the "monotonic"
 * promise meaningless; the narrow UI-lying cost is accepted instead.
 */
export class ProgressMachine {
  private state: ProgressState = 'idle'
  private percent = 0
  private mode: ProgressMode | null = null
  private message: string | undefined = undefined
  private turn: number | null = null
  private ok = true

  /**
   * Tool calls that have started and not yet finished, oldest first.
   *
   * A list rather than a single label because `tools/post-execute` must fall
   * back to whatever is *still* running, not blank the line: tools in this
   * harness run in sequence, but a nested/subagent call can legitimately overlap,
   * and "the most recently started unfinished tool" is the honest answer either
   * way. `tools/pre-execute` appends, `tools/post-execute` removes by `callId`.
   */
  private inFlight: InFlightTool[] = []
  /** Subagent run ids currently running, so `end` can match the right `start`. */
  private subagents: string[] = []
  /** Set from `agent/status`; read by the idle watchdog, never displayed raw. */
  private agentRunning = false
  /** Ids of approvals asked but not yet decided. Non-empty ⇒ a human is deciding. */
  private pendingApprovals: string[] = []

  /**
   * Begin a new turn. Resets to the 5% floor and clears any precise lock —
   * progress is per-turn, so last turn's precise value must not leak forward.
   *
   * Idempotent for a turn already in progress: `session/event` replays history
   * on attach, so the same `turn/start` can arrive more than once. Re-resetting
   * on a replay would make the displayed value jump backwards, violating the
   * monotonicity invariant. Only a genuinely different turn resets.
   */
  startTurn(turn: number): ProgressSnapshot {
    if (this.turn !== null && this.turn === turn && this.state !== 'idle') {
      return this.snapshot()
    }

    this.state = 'estimated'
    this.percent = TURN_START_PERCENT
    this.mode = 'estimated'
    this.message = undefined
    // Work from the previous turn is over; carrying any of it forward would show
    // stale text until the new turn produces its own events. A pending approval
    // is cleared too: its `decided` may never arrive (reload, crash), and a stuck
    // "等待批准" plus a permanent idle-suppression would survive forever.
    this.inFlight = []
    this.subagents = []
    this.pendingApprovals = []
    this.turn = turn
    this.ok = true
    return this.snapshot()
  }

  /**
   * Overrides the derived label with a caller-supplied one.
   *
   * Used for the todo-derived label, which is a better answer than any tool name
   * ("implement hover labels" beats "Edit"). It wins over in-flight tools because
   * callers only pass it when a todo item is actively `in_progress`.
   *
   * Deliberately does NOT touch the percentage: a label arrives on events that
   * say nothing about completion, and letting one move the bar would make the
   * displayed value move on no evidence.
   *
   * `undefined` is ignored rather than stored, so a payload with no readable
   * text cannot blank a label that is already showing.
   */
  setCurrentTask(task: string | undefined): ProgressSnapshot {
    if (task !== undefined && task.length > 0) {
      // Modelled as an in-flight entry so it participates in the same stack as
      // tool labels; `toolFinished` never removes this one (unknown callId).
      this.inFlight = [{ callId: TODO_LABEL_ID, label: task }]
    }
    return this.snapshot()
  }

  /**
   * `tools/pre-execute` fired: a tool call is starting.
   *
   * Re-adding an existing `callId` replaces it in place, so a replayed event
   * cannot accumulate duplicates.
   */
  toolStarted(callId: string, label: string): ProgressSnapshot {
    this.inFlight = [...this.inFlight.filter((t) => t.callId !== callId), { callId, label }]
    return this.snapshot()
  }

  /**
   * `tools/post-execute` fired: that call is no longer "what is happening".
   *
   * An unknown `callId` is a no-op rather than an error — the todo-derived label
   * is not a real tool and must survive a post-execute that follows it.
   */
  toolFinished(callId: string): ProgressSnapshot {
    const next = this.inFlight.filter((t) => t.callId !== callId)
    if (next.length !== this.inFlight.length) this.inFlight = next
    return this.snapshot()
  }

  /**
   * `subagent/start` / `subagent/end`. Tracked separately from tools so the two
   * counts cannot corrupt each other.
   */
  subagentStarted(runId: string): ProgressSnapshot {
    if (!this.subagents.includes(runId)) this.subagents = [...this.subagents, runId]
    return this.snapshot()
  }

  subagentFinished(runId: string): ProgressSnapshot {
    this.subagents = this.subagents.filter((id) => id !== runId)
    return this.snapshot()
  }

  /**
   * `agent/status`. Not displayed; read by the idle watchdog so a long silent
   * tool call is not mistaken for an abandoned session.
   */
  setAgentRunning(running: boolean): ProgressSnapshot {
    this.agentRunning = running
    return this.snapshot()
  }

  /**
   * `approval/asked` — a human is now deciding something.
   *
   * Recorded by id so overlapping asks release in the right order, and a
   * `decided` for a request this process never saw cannot clear a live hold.
   */
  approvalAsked(id: string): ProgressSnapshot {
    if (!this.pendingApprovals.includes(id)) {
      this.pendingApprovals = [...this.pendingApprovals, id]
    }
    return this.snapshot()
  }

  /** `approval/decided` — that ask is settled, whatever the outcome was. */
  approvalDecided(id: string): ProgressSnapshot {
    this.pendingApprovals = this.pendingApprovals.filter((pending) => pending !== id)
    return this.snapshot()
  }

  /**
   * Advance the estimate from a step number. Ignored entirely while in
   * `precise` — a heuristic must never touch a precise value.
   */
  onStep(step: number): ProgressSnapshot {
    if (this.state !== 'estimated') return this.snapshot()

    // estimatePercent returns a 0..90 percentage; this machine stores 0..1.
    const candidate = Math.min(ESTIMATE_CEILING, estimatePercent(step) / 100)
    if (candidate > this.percent) this.percent = candidate
    return this.snapshot()
  }

  /**
   * Record an explicitly reported value and lock the machine to `precise`.
   * Non-finite input is ignored rather than throwing; the value is clamped
   * to [0, 1] and can only move forwards.
   */
  reportPrecise(percent: number, message?: string): ProgressSnapshot {
    if (!Number.isFinite(percent)) return this.snapshot()

    const clamped = Math.min(1, Math.max(0, percent))
    if (clamped > this.percent) this.percent = clamped

    this.state = 'precise'
    this.mode = 'precise'
    if (message !== undefined) this.message = message
    return this.snapshot()
  }

  /**
   * Close the turn. Only `completed` may claim 100%; every other reason —
   * including a reason string this build has never heard of, since
   * `TurnEndReasonMap` is merge-extensible — reports failure at the current
   * value. Reporting an interruption as 100% would be actively misleading.
   */
  endTurn(reasonKind: string): ProgressSnapshot {
    this.state = 'done'
    if (reasonKind === 'completed') {
      this.percent = 1
      this.ok = true
    } else {
      this.ok = false
    }
    return this.snapshot()
  }

  reset(): ProgressSnapshot {
    this.state = 'idle'
    this.percent = 0
    this.mode = null
    this.message = undefined
    this.inFlight = []
    this.subagents = []
    this.agentRunning = false
    this.pendingApprovals = []
    this.turn = null
    this.ok = true
    return this.snapshot()
  }

  /**
   * The label shown in the hover panel, derived rather than stored.
   *
   * Derived so the two sources cannot disagree: whatever is still in flight *is*
   * the answer, and a subagent count appears only when it is actually news
   * (more than one). The most recently started unfinished tool wins, which is the
   * closest a sequential harness gets to "what is happening right now".
   */
  private taskLabel(): string | undefined {
    // A pending approval outranks everything: it is the one thing the user has to
    // act on, and while it is pending nothing else can progress anyway.
    const base = this.pendingApprovals.length > 0
      ? '等待批准'
      : this.inFlight.length > 0
        ? this.inFlight[this.inFlight.length - 1]!.label
        : undefined
    if (this.subagents.length <= 1) return base
    return base === undefined ? `${this.subagents.length} 个子代理运行中` : `${base} · ${this.subagents.length} 子代理`
  }

  /** Returns a fresh object so callers cannot mutate internal state. */
  snapshot(): ProgressSnapshot {
    return {
      state: this.state,
      percent: this.percent,
      mode: this.mode,
      message: this.message,
      currentTask: this.taskLabel(),
      agentRunning: this.agentRunning,
      subagentCount: this.subagents.length,
      approvalPending: this.pendingApprovals.length > 0,
      turn: this.turn,
      ok: this.ok,
    }
  }
}
