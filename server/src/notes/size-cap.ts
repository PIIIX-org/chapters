import { config } from '../config.js'
import { OkfValidationError } from './okf.js'

/**
 * One size cap for every write path (#491): REST, MCP, import and the collab
 * relay store a note body of at most `config.noteMaxBytes` (ELARA_NOTE_MAX_BYTES,
 * default 1 MiB), measured as the body's UTF-8 bytes (frontmatter is not
 * counted; the transport limit below bounds it). Before this, REST and MCP
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
  constructor(bytes: number, limit: number) {
    super(`note body is ${bytes} bytes (UTF-8); the limit is ${limit} bytes (ELARA_NOTE_MAX_BYTES)`)
  }
}

/** Throws NoteTooLargeError unless `body` may replace `current` (absent for a new note). */
export function assertBodyFits(body: string, current?: string): void {
  const limit = config.noteMaxBytes
  // UTF-8 takes at most 3 bytes per UTF-16 unit: most bodies need no count.
  if (body.length * 3 <= limit) return
  const bytes = Buffer.byteLength(body, 'utf8')
  if (bytes <= limit) return
  if (current !== undefined && bytes <= Buffer.byteLength(current, 'utf8')) return
  throw new NoteTooLargeError(bytes, limit)
}

/**
 * Largest request body (REST note writes, MCP) and collab websocket frame
 * accepted before it is read. Above the cap so a body at the cap still
 * arrives: JSON escaping grows text (`\n` doubles a byte, a `\u`-escaped
 * character takes up to 12 bytes for 4), and frontmatter rides along. The
 * exact check is assertBodyFits.
 */
export function noteTransportLimit(): number {
  return 4 * config.noteMaxBytes + 64 * 1024
}
