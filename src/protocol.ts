/**
 * NDJSON wire protocol between the plugin (client) and the native helper
 * (server). One JSON object per line, UTF-8.
 *
 * The plugin is the client: the helper owns the listening socket because the
 * helper is the side that restarts, and letting the stable side reconnect is
 * simpler than letting it accept reconnections. See spec §3.
 */

export type OutboundMessage =
  | { type: 'hello'; version: number }
  | {
      type: 'progress'
      percent: number
      mode: 'estimated' | 'precise'
      message?: string
      /** Short description of the work in progress, for the hover panel. */
      task?: string
    }
  | { type: 'done'; reason: string; ok: boolean }
  | { type: 'bye' }

export const PROTOCOL_VERSION = 1

export type ValidatedProgress =
  | { ok: true; percent: number; mode: 'estimated' | 'precise' }
  | { ok: false; reason: string }

/**
 * Serializes one message to a single line, WITHOUT a trailing newline.
 *
 * The result is asserted to contain no raw `\n`/`\r`: a literal newline inside
 * a JSON string would split one logical message across two frames and desync
 * the reader for the rest of the connection.
 */
export function encodeMessage(msg: OutboundMessage): string {
  const line = JSON.stringify(msg)
  if (line.includes('\n') || line.includes('\r')) {
    // JSON.stringify escapes real newlines, so reaching here means a value
    // carried a raw control character through an unexpected path. Fail loudly
    // rather than emit a frame that desyncs the stream.
    throw new Error('encodeMessage: encoded line contains a raw newline')
  }
  return line
}

/**
 * Splits a received buffer into complete messages plus an unfinished tail.
 *
 * The tail is returned unparsed and must be prepended to the next read — a
 * frame can be split across any number of reads, and parsing a partial frame
 * would either throw or (worse) silently drop a message.
 */
export function decodeMessages(buffer: string): { messages: unknown[]; rest: string } {
  const messages: unknown[] = []
  let cursor = 0

  for (;;) {
    const newlineAt = buffer.indexOf('\n', cursor)
    if (newlineAt === -1) break

    const line = buffer.slice(cursor, newlineAt).trim()
    cursor = newlineAt + 1
    if (line.length === 0) continue

    try {
      messages.push(JSON.parse(line))
    } catch {
      // A malformed line is dropped, not fatal: one corrupt frame must not
      // take down the progress channel for the rest of the session.
    }
  }

  return { messages, rest: buffer.slice(cursor) }
}

/**
 * Validates and normalizes an inbound `progress` message.
 *
 * Rejects anything that is not a finite number in a recognized mode rather
 * than coercing it: a `NaN` percent rendered into the UI would show garbage,
 * and silently defaulting a bad value to 0 would look like real regression.
 */
export function validateProgress(msg: unknown): ValidatedProgress {
  if (typeof msg !== 'object' || msg === null) {
    return { ok: false, reason: 'not an object' }
  }

  const record = msg as Record<string, unknown>
  if (record.type !== 'progress') {
    return { ok: false, reason: `unexpected type: ${String(record.type)}` }
  }

  const percent = record.percent
  if (typeof percent !== 'number' || !Number.isFinite(percent)) {
    return { ok: false, reason: 'percent is not a finite number' }
  }

  const mode = record.mode
  if (mode !== 'estimated' && mode !== 'precise') {
    return { ok: false, reason: `unknown mode: ${String(mode)}` }
  }

  return { ok: true, percent: Math.min(1, Math.max(0, percent)), mode }
}
