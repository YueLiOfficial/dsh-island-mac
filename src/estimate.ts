/**
 * Bounded asymptotic progress estimator.
 *
 * Returns a percentage in [5, 90] — NOT a 0..1 fraction. The 90 ceiling is a
 * hard cap: the estimate layer must never claim completion, so 100% can only
 * come from a real terminal signal (`turn/end` completed) or an explicit
 * precise report. See spec §4.2.
 *
 * Step numbers are not guaranteed to start at 1 or increment by 1 — a single
 * subagent delegation can make them jump. So this uses only the monotonicity
 * of `step`, never a `step / N` linear assumption.
 */

const FLOOR = 5
const CEILING = 90
/** Larger ⇒ slower approach to the ceiling. Tuned so step=10 ≈ 58%. */
const RAMP = 6

export function estimatePercent(step: number): number {
  // Infinities and NaN must degrade to a bound, never propagate as NaN.
  if (Number.isNaN(step) || step <= 0) return FLOOR
  if (!Number.isFinite(step)) return CEILING

  const raw = FLOOR + (CEILING - FLOOR) * (step / (step + RAMP))
  return Math.min(CEILING, raw)
}
