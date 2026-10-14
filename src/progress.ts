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
  turn: number | null
  ok: boolean
}

/** Fraction at which a new turn starts. Matches spec §4.3. */
const TURN_START_PERCENT = 0.05

/**
 * Hard ceiling for the estimate layer, as a fraction. The estimator itself
 * caps at 90%; this re-asserts it so no future estimator change can let an
 * estimate claim completion.
 */
const ESTIMATE_CEILING = 0.9

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
    this.turn = turn
    this.ok = true
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
    this.turn = null
    this.ok = true
    return this.snapshot()
  }

  /** Returns a fresh object so callers cannot mutate internal state. */
  snapshot(): ProgressSnapshot {
    return {
      state: this.state,
      percent: this.percent,
      mode: this.mode,
      message: this.message,
      turn: this.turn,
      ok: this.ok,
    }
  }
}
