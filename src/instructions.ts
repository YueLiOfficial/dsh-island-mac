import { REPORT_PROGRESS_TOOL_NAME } from './tool.ts'

/**
 * Sort order for this plugin's system-prompt section.
 *
 * Placed after the core sections. The knowledge base does not enumerate
 * `PromptSectionOrderName`'s members, but `PromptSection.order` is a plain
 * number and third-party contributions may set it directly —
 * `getSectionOrder()` exists to resolve the repository's own centrally owned
 * placements, not to gate outside plugins. The section `name` carries a
 * plugin-specific prefix, so even an order collision cannot shadow a built-in
 * section.
 */
export const SYSTEM_PROMPT_SECTION_ORDER = 900

const SECTION_NAME = 'dynamic-island-progress/instructions'

/**
 * The system-prompt section that makes `report_progress` reachable.
 *
 * Registering a tool tells the model the function exists; it says nothing
 * about *when* the function is worth calling. Without this section the tool
 * is dead code: `estimated` never transitions to `precise` and only the
 * heuristic ever drives the indicator.
 *
 * Deliberately static text rather than `ctx.systemPrompt.context()`: dynamic
 * runtime context is written into retained model history as a user-role
 * snapshot, and feeding the current percentage back to the model would let it
 * observe changes it caused — an invitation to report in a loop.
 *
 * Returns a `PromptSection` (minus the registry call) so the content is
 * unit-testable without a Cordis context.
 */
export function buildProgressInstruction(): { name: string; order: number; text: string } {
  return {
    name: SECTION_NAME,
    order: SYSTEM_PROMPT_SECTION_ORDER,
    text: [
      'A progress indicator in the macOS notch shows how far the current task has gotten.',
      'It appears on its own when work starts and disappears when the turn ends, so there is',
      'nothing to do in order to show or hide it.',
      '',
      'The harness estimates progress automatically from step counts and from the todo list,',
      'and that estimate is deliberately capped below 100%: only a real turn completion or an',
      'explicit report may claim completion. Most tasks therefore need no intervention.',
      '',
      `仅在下列情况之一成立时才调用 \`${REPORT_PROGRESS_TOOL_NAME}\`：它是可选的覆盖手段，`,
      '而不是每一步都要走的仪式。以下是这些情况：',
      '  - You know a more accurate completion figure than the estimate — for example you have a',
      '    known list of N steps and have finished k of them.',
      '  - A single step will run for a long time (a slow build, a long download) and the estimate',
      '    would otherwise stall, so the user benefits from a status line.',
      '',
      'When you do call it, `percent` is a fraction in [0, 1] — pass 0.5 for half done, not 50.',
      'The displayed value never moves backwards, so reporting a lower number cannot rewind it.',
      'Do not call it after every step: the todo list already supplies an exact ratio, and',
      'frequent reports only add noise.',
    ].join('\n'),
  }
}
