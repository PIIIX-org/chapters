import { config } from '../config.js'
import { OkfValidationError } from './okf.js'

/**
 * One size cap for every write path (#491): REST, MCP, import and the collab
 * relay store a note body of at most `config.noteMaxBytes` (ELARA_NOTE_MAX_BYTES,
 * default 1 MiB), measured as the body's UTF-8 bytes. The frontmatter is
 * bounded by the same cap, counted apart (assertFrontmatterFits, #933). Before this, REST and MCP
 * refused only when Fastify's 1 MiB *request* limit tripped, import took any
 * size, and the relay stored up to ws's 100 MiB default.
 *
 * A note stored before the cap (or under a larger one) is not trapped: a write
 * that is over the cap but no larger than the body it replaces is allowed, so
 * such a note can still shrink and take frontmatter edits. Restore of a backup
 * is exempt (export/restore.ts): dropping a backed-up note would lose data.
 *
 * An OkfValidationError, so every caller that reports a refused note (import's
 * `skipped`, restore, MCP's tool error) reports this one the same way; REST
 * answers 413.
 */
export class NoteTooLargeError extends OkfValidationError {
  readonly statusCode = 413
  /**
   * `atLeast`: `bytes` is a lower bound, for a body refused before it is built.
   * `part`: what is over the cap, the body or (#933) the frontmatter. The
   * error envelope's `rule` (#439) names the limit of that part.
   */
  constructor(bytes: number, limit: number, context?: string, atLeast = false, part: 'body' | 'frontmatter' = 'body') {
    const what = part === 'body' ? 'body' : 'frontmatter (keys and values as JSON)'
    super(
      `${context ? `${context}: ` : ''}note ${what} ${atLeast ? 'would be at least' : 'is'} ${bytes} bytes (UTF-8); the limit is ${limit} bytes (ELARA_NOTE_MAX_BYTES)`,
      'invalid',
      `note ${what} at most ${limit} bytes (UTF-8, ELARA_NOTE_MAX_BYTES)`,
    )
  }
}

/**
 * Throws NoteTooLargeError unless `body` may replace `current` (absent for a
 * new note). `context` leads the message when the body is not the one the
 * caller sent (a rename's link rewrite).
 */
export function assertBodyFits(body: string, current?: string, context?: string): void {
  const limit = config.noteMaxBytes
  // UTF-8 takes at most 3 bytes per UTF-16 unit: most bodies need no count.
  if (body.length * 3 <= limit) return
  const bytes = Buffer.byteLength(body, 'utf8')
  if (bytes <= limit) return
  if (current !== undefined && bytes <= Buffer.byteLength(current, 'utf8')) return
  throw new NoteTooLargeError(bytes, limit, context)
}

/**
 * assertBodyFits for a body of `length` UTF-16 units that is not built yet
 * (an edit_note op's result, #408), so a refused one never takes the memory.
 * A UTF-16 unit is at least one UTF-8 byte (a pair is four), so a length
 * over the cap is a body over it; a length within it is checked again on
 * the built body.
 */
export function assertLengthFits(length: number, current?: string, context?: string): void {
  const limit = config.noteMaxBytes
  if (length <= limit) return
  if (current !== undefined && length <= Buffer.byteLength(current, 'utf8')) return
  throw new NoteTooLargeError(length, limit, context, true)
}

/**
 * Bytes `value` takes written out as JSON (strings with their quotes and
 * escapes, as UTF-8); binary data (a Yjs value) counts its length. Measured
 * without building the JSON text: a large Uint8Array would turn into an
 * object ten times its size. One measure for frontmatter on every write path
 * (#933) and the rest of a live document on the relay (#780, collab-size.ts).
 */
export function jsonBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(JSON.stringify(value), 'utf8')
  if (value === null || value === undefined) return 4
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value).length
  if (value instanceof Uint8Array) return value.length
  if (Array.isArray(value)) {
    let bytes = 2 + Math.max(0, value.length - 1)
    for (const item of value) bytes += jsonBytes(item)
    return bytes
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value)
    let bytes = 2 + Math.max(0, entries.length - 1)
    for (const [key, item] of entries) bytes += jsonBytes(key) + 1 + jsonBytes(item)
    return bytes
  }
  return 0
}

/**
 * A frontmatter map's size as the collab relay measures the rest of a live
 * document (#780): each key's UTF-8 bytes plus its value as JSON.
 */
export function frontmatterBytes(frontmatter: Record<string, unknown>): number {
  let bytes = 0
  for (const [key, value] of Object.entries(frontmatter)) bytes += Buffer.byteLength(key, 'utf8') + jsonBytes(value)
  return bytes
}

/**
 * The body cap's rule for frontmatter (#933), counted apart from the body:
 * throws NoteTooLargeError unless `frontmatter` is within the cap or no
 * larger than `current` (absent for a new note), so per-key merges cannot
 * grow it past the cap and a note already over it can still shrink.
 */
export function assertFrontmatterFits(frontmatter: Record<string, unknown>, current?: Record<string, unknown>): void {
  const limit = config.noteMaxBytes
  const bytes = frontmatterBytes(frontmatter)
  if (bytes <= limit) return
  if (current !== undefined && bytes <= frontmatterBytes(current)) return
  throw new NoteTooLargeError(bytes, limit, undefined, false, 'frontmatter')
}

/**
 * Largest request body (REST note writes, MCP) and collab websocket frame
 * accepted before it is read. Above the cap so a body at the cap still
 * arrives in its worst JSON escaping: a control character is one byte of
 * UTF-8 and six of JSON (`\u0001`), more than any other character (`\n` takes
 * two bytes for one, a 3-byte character at most 6 escaped); 64 KiB more for
 * frontmatter and the envelope. The exact check is assertBodyFits.
 */
export function noteTransportLimit(): number {
  return 6 * config.noteMaxBytes + 64 * 1024
}
