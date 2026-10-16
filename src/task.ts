/**
 * Human-readable "what is happening right now" labels for the island's
 * hover-reveal line.
 *
 * Every function here is **pure and total**: session-event payloads cross a
 * persisted-log boundary and tool arguments are raw model output, so a
 * malformed input must degrade to `null` (or a generic label), never throw.
 * That mirrors the contract in `events.ts`.
 *
 * Labels are deliberately Chinese: they are user-facing chrome, not diagnostics,
 * and the rest of the panel is Chinese too.
 */

/**
 * Upper bound on a label, in code points. The line lives under a physical notch
 * and inside a fixed-width panel, so an unbounded path or command would push the
 * layout around. Truncation is by code point, never by UTF-16 unit, so an emoji
 * or any astral character is never sliced into a lone surrogate.
 *
 * There is deliberately no separate short form for the compact pill: the pill
 * shows only a percentage, so the full-enough label is only ever read in the
 * expanded panel.
 */
export const MAX_TASK_LENGTH = 80

/** Truncates to `max` code points, appending `…` when something was dropped. */
export function truncateTask(text: string, max: number = MAX_TASK_LENGTH): string {
  const points = [...text]
  if (points.length <= max) return text
  return `${points.slice(0, max - 1).join('')}…`
}

/**
 * Upper bound for one-line detail folded into a label, in code points.
 *
 * Tighter than `MAX_TASK_LENGTH` because a detail shares its line with a prefix
 * (e.g. "等待批准：bash · …") and the panel gives the label three lines.
 */
export const MAX_DETAIL_LENGTH = 100

/**
 * Makes arbitrary text safe to fold into a one-line label.
 *
 * Two jobs, both non-negotiable for text that reaches the wire:
 *
 * 1. Newlines and carriage returns are flattened to spaces. A raw `\n` inside a
 *    JSON string would split one logical message across two frames and desync the
 *    NDJSON reader for the rest of the connection.
 * 2. Truncation is by CODE POINT, never by UTF-16 unit, so an emoji or any astral
 *    character is never sliced into a lone surrogate.
 *
 * The input here is model-authored free text (an approval `reason`), so both are
 * reachable, not theoretical.
 */
export function sanitizeDetail(text: string, max: number = MAX_DETAIL_LENGTH): string {
  const flattened = text.replaceAll('\n', ' ').replaceAll('\r', ' ').trim()
  return truncateTask(flattened, max)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Reads a trimmed, non-empty string field, or null. */
function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

/**
 * First line only. A multi-line shell command or a heredoc would otherwise blow
 * past every length budget and read as noise.
 */
function firstLine(text: string): string {
  return text.split(/\r\n|\r|\n/, 1)[0]!.trim()
}

/**
 * The in-progress item's own text, which is the best available answer to "what
 * is the current task": the model wrote it itself, so it names the task rather
 * than the mechanic being used to do it.
 *
 * The first `in_progress` entry wins; a list with two of them has no single
 * answer and taking the first is at least stable across updates.
 */
export function currentTaskFromTodos(data: unknown): string | null {
  if (!isRecord(data)) return null
  const todos = data.todos
  if (!Array.isArray(todos)) return null

  for (const todo of todos) {
    if (!isRecord(todo)) continue
    if (todo.status !== 'in_progress') continue
    const content = readString(todo, 'content')
    if (content !== null) return truncateTask(content)
  }
  return null
}

/**
 * Tool-name aliases, matched exactly after normalisation (lower-cased, with `_`
 * and `-` removed) rather than by substring.
 *
 * Substring matching was rejected deliberately: `contains('read')` also matches
 * `thread`, so an unrelated future tool would silently render as "查看文件". A
 * tool this build has never heard of falls back to its own name, which is
 * honest.
 */
const FILE_READ = new Set(['read', 'readfile', 'view', 'viewfile', 'cat'])
const FILE_WRITE = new Set(['write', 'writefile', 'create', 'createfile'])
const FILE_EDIT = new Set([
  'edit',
  'editfile',
  'multiedit',
  'applypatch',
  'strreplaceeditor',
  'patch',
])
const FIND = new Set(['glob', 'find', 'listdir', 'ls'])
const SEARCH = new Set(['grep', 'search', 'searchfiles', 'ripgrep', 'rg'])
const WEB_SEARCH = new Set(['websearch', 'searchweb'])
const WEB_FETCH = new Set(['webfetch', 'fetchurl', 'fetch'])
const BASH = new Set(['bash', 'shell', 'runcommand', 'exec', 'execute'])
const TODO = new Set(['todowrite', 'todo', 'todoread', 'taskwrite'])
const PROGRESS = new Set(['reportprogress', 'reportprogresspercent'])

function normaliseName(name: string): string {
  return name.toLowerCase().replaceAll('_', '').replaceAll('-', '')
}

/**
 * Normalizes tool arguments into an object.
 *
 * Accepts BOTH shapes on purpose, because the two event sources disagree:
 *
 * - `session/event`'s `tool/call` carries `arguments` as the model's **raw,
 *   unparsed JSON string**.
 * - Cordis `tools/pre-execute` carries `exec.arguments` as an **already-parsed
 *   object** (proved by `preToolPayload` embedding it directly as `tool_input`;
 *   a string there would be double-encoded).
 *
 * Accepting only one shape would not fail loudly — every label would silently
 * degrade to its generic form. Returns null for anything that is not an object,
 * including valid JSON that is not one (arrays, bare strings), which is a shape
 * models do occasionally emit. Never throws.
 */
function parseArguments(raw: unknown): Record<string, unknown> | null {
  if (isRecord(raw)) return raw
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** First present, non-empty string among `keys`. */
function pick(args: Record<string, unknown> | null, keys: readonly string[]): string | null {
  if (args === null) return null
  for (const key of keys) {
    const value = readString(args, key)
    if (value !== null) return value
  }
  return null
}

/**
 * A readable label for the tool call currently executing, used only when no
 * in-progress todo supplies a better answer.
 *
 * `name` is the tool name as the model invoked it. `rawArguments` may be either
 * the raw JSON string (`tool/call`) or an already-parsed object
 * (`tools/pre-execute`) — see `parseArguments`.
 */
export function currentTaskFromToolCall(name: unknown, rawArguments: unknown): string | null {
  if (typeof name !== 'string') return null
  const trimmedName = name.trim()
  if (trimmedName.length === 0) return null

  const args = parseArguments(rawArguments)
  const normalised = normaliseName(trimmedName)

  // An empty prefix means "the value IS the label" — joining on `：` there would
  // emit a leading separator.
  const label = (prefix: string, value: string | null): string => {
    if (prefix.length === 0) return truncateTask(value ?? '')
    return truncateTask(value === null ? prefix : `${prefix}：${value}`)
  }

  // `description` first: the harness's Bash tool has the model write a short
  // human summary there, which beats echoing the command back.
  if (BASH.has(normalised)) {
    const description = pick(args, ['description'])
    const command = pick(args, ['command', 'cmd', 'script'])
    if (description !== null) return label('', description)
    return label('执行命令', command === null ? null : firstLine(command))
  }

  if (FILE_READ.has(normalised)) {
    return label('查看文件', pick(args, ['file_path', 'path', 'file', 'filename']))
  }
  if (FILE_WRITE.has(normalised)) {
    return label('写入文件', pick(args, ['file_path', 'path', 'file', 'filename']))
  }
  if (FILE_EDIT.has(normalised)) {
    return label('修改文件', pick(args, ['file_path', 'path', 'file', 'filename']))
  }
  if (FIND.has(normalised)) {
    return label('查找文件', pick(args, ['pattern', 'glob', 'path', 'query']))
  }
  if (SEARCH.has(normalised)) {
    return label('搜索内容', pick(args, ['pattern', 'query', 'path']))
  }
  if (WEB_SEARCH.has(normalised)) {
    return label('搜索网页', pick(args, ['query', 'q']))
  }
  if (WEB_FETCH.has(normalised)) {
    return label('抓取网页', pick(args, ['url', 'uri']))
  }
  if (TODO.has(normalised)) return '整理任务清单'
  if (PROGRESS.has(normalised)) return '上报进度'

  return truncateTask(`正在使用 ${trimmedName}`)
}
