import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ProgressMachine, ProgressSnapshot } from './progress.ts'

/** The tool name the model sees. Also referenced by the system-prompt section. */
export const REPORT_PROGRESS_TOOL_NAME = 'report_progress'

/**
 * Upper bound on a progress message, in code points. The message is rendered
 * into a notch-sized label and shipped inside a JSON frame per update, so an
 * unbounded string is both a UI and a wire hazard.
 */
export const MESSAGE_MAX_LENGTH = 200

/**
 * The callable API other plugin code uses to report progress.
 *
 * Exposed as a Cordis service (`ctx.provide('islandProgress', ...)`) so task
 * code that is not the `report_progress` tool can report too.
 */
export interface IslandProgressService {
  report(percent: number, message?: string): void
  current(): ProgressSnapshot
}

/**
 * Truncates by code point, not by UTF-16 unit, so an emoji or any astral
 * character is never sliced into a lone surrogate. Newlines are folded to
 * spaces because a raw newline inside a JSON string would break the NDJSON
 * framing the transport relies on.
 */
function sanitizeMessage(message: string): string {
  const flattened = message.replaceAll('\n', ' ').replaceAll('\r', ' ')
  if (flattened.length <= MESSAGE_MAX_LENGTH) return flattened
  return [...flattened].slice(0, MESSAGE_MAX_LENGTH).join('')
}

/**
 * Wraps a machine as the reporting service.
 *
 * `onPublish` fires only when a value was actually accepted, so a rejected
 * `NaN` does not produce a pointless socket write.
 */
export function createProgressService(
  machine: ProgressMachine,
  onPublish: (snapshot: ProgressSnapshot) => void,
): IslandProgressService {
  return {
    report(percent: number, message?: string): void {
      // Reject non-finite input before touching the machine. The machine
      // would ignore it too, but returning early avoids a spurious publish.
      if (!Number.isFinite(percent)) return

      const clamped = Math.min(1, Math.max(0, percent))
      const snapshot = machine.reportPrecise(
        clamped,
        message === undefined ? undefined : sanitizeMessage(message),
      )
      onPublish(snapshot)
    },
    current(): ProgressSnapshot {
      return machine.snapshot()
    },
  }
}

/**
 * Builds the `report_progress` tool definition.
 *
 * Returned rather than registered so it can be unit-tested without a Cordis
 * context. Registration is the caller's job (`ctx.tools.register`), which also
 * makes the registration effect-scoped and auto-disposed with the plugin.
 */
export function buildReportProgressTool(service: IslandProgressService) {
  return defineTool({
    name: REPORT_PROGRESS_TOOL_NAME,
    description:
      'Report how far the current task has progressed, as a fraction. ' +
      'Optional: the harness estimates progress automatically from steps and ' +
      'the todo list, so call this only when you know a more accurate value ' +
      '(for example you have a known list of steps) or when a single long ' +
      'step would otherwise leave the indicator stalled. Do not call it after ' +
      'every step. The displayed value never moves backwards, so reporting a ' +
      'lower value will not rewind the indicator.',
    parameters: {
      percent: {
        type: 'number',
        required: true,
        description: 'Completion fraction in [0, 1]. Use 0.5 for half done — not 50.',
      },
      message: {
        type: 'string',
        description: 'Optional short status line, at most 200 characters.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' } },
      },
      render: (_args, value) => {
        const ok = (value as { ok?: unknown }).ok === true
        return [{ type: 'text', text: ok ? 'progress recorded' : 'progress not recorded' }]
      },
    },
    async execute(args, exec) {
      // Honour cancellation: a call that was aborted mid-flight must not
      // publish a value the caller already abandoned.
      if (exec.signal.aborted) return { ok: false }
      service.report(args.percent, args.message)
      return { ok: true }
    },
  })
}
