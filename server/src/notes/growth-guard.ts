/**
 * Write quarantine (#492). A stale reload once doubled a whole note (#488) and
 * every write path stored the doubled body as an ordinary edit. A write is
 * suspicious when, measured against the note's stored body:
 *
 * - growth: it makes the body at least GROWTH_RATIO times as large, and the
 *   stored body is at least GROWTH_MIN_PREVIOUS_BYTES (a stub filled in, the
 *   normal agent pattern, is never flagged);
 * - repeated block: text already in the stored body appears more often than
 *   it did, and those extra copies add up to at least REPEAT_MIN_BYTES and
 *   REPEAT_MIN_SHARE of the stored body (a doubled note repeats all of it).
 *
 * Callers keep a suspicious write out of the note and record it as a
 * `quarantine` revision (store.ts `refuseSuspiciousWrite`). Sizes are UTF-8
 * bytes. Both checks are linear in the two bodies (one pass each, one map
 * of chunks), a few milliseconds on a 1 MiB note.
 */

export const GROWTH_RATIO = 1.9
export const GROWTH_MIN_PREVIOUS_BYTES = 2 * 1024
export const REPEAT_MIN_BYTES = 1024
export const REPEAT_MIN_SHARE = 0.5

/** `all`: MCP edit_note and REST PUT. `repeated-block`: the collab relay, where a human types and pastes what they see. */
export type QuarantineRules = 'all' | 'repeated-block'

export interface SuspiciousWrite {
  rule: 'growth' | 'repeated-block'
  previousBytes: number
  nextBytes: number
  /** Bytes of text from the stored body that the write adds again. */
  repeatedBytes: number
}

/**
 * Content-defined chunks: a rolling hash over the last 32 characters picks
 * the cut points, so a copy of a passage is cut the same way as the original
 * wherever the copy starts, with or without newlines. About one cut per 64
 * characters past the minimum.
 */
const MIN_CHUNK = 16
const MAX_CHUNK = 512
const CUT_SHIFT = 26 // cut where the hash's top 6 bits are zero: 1 in 64

const GEAR = new Uint32Array(256)
{
  let s = 0x9e3779b9
  for (let i = 0; i < GEAR.length; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    GEAR[i] = s >>> 0
  }
}

function forEachChunk(text: string, visit: (chunk: string) => void): void {
  let hash = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    hash = ((hash << 1) + GEAR[(c ^ (c >>> 8)) & 0xff]!) >>> 0
    const len = i - start + 1
    if ((len >= MIN_CHUNK && hash >>> CUT_SHIFT === 0) || len >= MAX_CHUNK) {
      visit(text.slice(start, i + 1))
      start = i + 1
    }
  }
  if (start < text.length) visit(text.slice(start))
}

/** Bytes of `next` that repeat chunks of `previous` beyond the number of times `previous` has them. */
function repeatedBytes(previous: string, next: string): number {
  /** chunk -> how many more times `next` may have it before a copy is a repeat */
  const unused = new Map<string, number>()
  forEachChunk(previous, (chunk) => unused.set(chunk, (unused.get(chunk) ?? 0) + 1))
  let repeated = 0
  forEachChunk(next, (chunk) => {
    const left = unused.get(chunk)
    if (left === undefined) return
    if (left > 0) unused.set(chunk, left - 1)
    else repeated += Buffer.byteLength(chunk)
  })
  return repeated
}

/** The rule `next` breaks against the stored `previous` body, or null for an ordinary write. */
export function suspiciousWrite(previous: string, next: string, rules: QuarantineRules): SuspiciousWrite | null {
  const previousBytes = Buffer.byteLength(previous)
  const nextBytes = Buffer.byteLength(next)
  if (rules === 'all' && previousBytes >= GROWTH_MIN_PREVIOUS_BYTES && nextBytes >= GROWTH_RATIO * previousBytes) {
    return { rule: 'growth', previousBytes, nextBytes, repeatedBytes: 0 }
  }
  const floor = Math.max(REPEAT_MIN_BYTES, REPEAT_MIN_SHARE * previousBytes)
  if (previousBytes === 0 || nextBytes < floor) return null
  const repeated = repeatedBytes(previous, next)
  return repeated >= floor ? { rule: 'repeated-block', previousBytes, nextBytes, repeatedBytes: repeated } : null
}

/**
 * A suspicious write that was kept out of the note. 409 over REST; an MCP
 * tool error. `code` is the rule, so a monitoring report (#705) names it.
 */
export class NoteWriteQuarantinedError extends Error {
  override readonly name = 'NoteWriteQuarantinedError'
  readonly statusCode = 409
  readonly code: SuspiciousWrite['rule']

  constructor(
    readonly path: string,
    readonly finding: SuspiciousWrite,
    readonly revisionId: string,
    /** True when this extends the quarantine already recorded last (a live document that stays doubled). */
    readonly repeat: boolean,
  ) {
    super(
      `write to ${path} quarantined: ${suspicionText(finding)}. The note keeps its current body; the refused body is kept as revision ${revisionId} ` +
        `(action "quarantine": note_history / get_revision show it, revert_note restores it). ` +
        `If the change is intended, send it again with allowGrowth: true.`,
    )
    this.code = finding.rule
  }
}

/** Why `finding` makes a write suspicious, in words. */
function suspicionText(finding: SuspiciousWrite): string {
  return finding.rule === 'growth'
    ? `the body would grow from ${finding.previousBytes} to ${finding.nextBytes} bytes (at least ${GROWTH_RATIO}x a note of ${GROWTH_MIN_PREVIOUS_BYTES} bytes or more)`
    : `it repeats ${finding.repeatedBytes} bytes of text the note already has (a repeated block: at least ${REPEAT_MIN_BYTES} bytes and half of the note's ${finding.previousBytes})`
}

/** A `dry_run` write (#477) that a real write would quarantine: nothing was recorded. 409 over REST; an MCP tool error. */
export class NoteWriteWouldQuarantineError extends Error {
  override readonly name = 'NoteWriteWouldQuarantineError'
  readonly statusCode = 409
  readonly code: SuspiciousWrite['rule']

  constructor(path: string, finding: SuspiciousWrite) {
    super(`dry run: a write to ${path} would be quarantined: ${suspicionText(finding)}. Nothing was written. If the change is intended, send it with allowGrowth: true.`)
    this.code = finding.rule
  }
}
