/**
 * Read targets (#416, ADR-004 §2.2): the parts of a document one read asks
 * for, by line range, heading path or symbol path. Pure functions over the
 * line contract (text/lines.ts) and the heading parser (text/blocks.ts), so
 * a heading resolves here exactly as `replace_section` and note blocks see
 * it.
 */
import { headings } from './blocks.js'
import { lineStarts } from './lines.js'

/** A 1-based inclusive line range. */
export type LineRange = [number, number]

/**
 * A `lines` target: `"a-b"`, `"a"` (one line) or `"a-"` (to the end), each
 * number optionally written `L<n>` as in a location string (`#L12-L40`).
 * Null when malformed or when `b < a`; `end` is null for `"a-"`.
 */
export function parseLineSpec(spec: string): { start: number; end: number | null } | null {
  const m = /^\s*L?(\d{1,9})\s*(?:(-)\s*(?:L?(\d{1,9}))?)?\s*$/i.exec(spec)
  if (!m) return null
  const start = Number(m[1])
  const end = m[3] !== undefined ? Number(m[3]) : m[2] ? null : start
  if (start < 1 || (end !== null && end < start)) return null
  return { start, end }
}

/**
 * Lines `a`..`b` of `text` with their line breaks: what a read shows of a
 * target, so a page boundary always falls between whole lines and a blank
 * last line still counts. `starts` is `lineStarts(text)`.
 */
export function wholeLines(text: string, a: number, b: number, starts: readonly number[] = lineStarts(text)): string {
  return text.slice(starts[a - 1], b < starts.length ? starts[b] : text.length)
}

/** A heading's section: the heading line through the line before the next heading of the same or a higher level. */
export interface HeadingSection {
  /** Heading titles from the top level down, joined with ` > ` (a note block's `inner_path`). */
  path: string
  lines: LineRange
}

/** Every heading section of `text` (headings in code fences are content), in document order; one pass. */
export function headingSections(text: string): HeadingSection[] {
  const starts = lineStarts(text)
  const lineAt = new Map(starts.map((offset, i) => [offset, i + 1]))
  const out: HeadingSection[] = []
  // The open sections, outermost first: a heading closes every open one of its level or deeper.
  const trail: Array<{ level: number; title: string; at: number }> = []
  for (const h of headings(text)) {
    const line = lineAt.get(h.start)!
    while (trail.length > 0 && trail.at(-1)!.level >= h.level) out[trail.pop()!.at]!.lines[1] = line - 1
    trail.push({ level: h.level, title: h.title, at: out.length })
    out.push({ path: trail.map((t) => t.title).join(' > '), lines: [line, starts.length] })
  }
  return out
}

/** `## Setup > Linux ` → `["Setup", "Linux"]`: segments split at `separator`, trimmed, heading marks dropped. */
export function segments(path: string, separator: string): string[] {
  return path
    .split(separator)
    .map((s) => s.trim().replace(/^#{1,6}\s+/, '').trim())
    .filter((s) => s !== '')
}

/**
 * The candidates a heading or symbol path names, by index: an exact match;
 * else a case-insensitive one; else every candidate whose last segments
 * equal the path's (case-insensitive), so `Linux` names `Setup > Linux` and
 * `save` names `Store.save`. Several indexes: the path is ambiguous.
 */
export function matchPath(wanted: string, candidates: readonly string[], separator: string): number[] {
  const want = segments(wanted, separator)
  if (want.length === 0) return []
  const joined = want.join(separator === '>' ? ' > ' : separator)
  const exact = candidates.flatMap((c, i) => (c === joined ? [i] : []))
  if (exact.length > 0) return exact
  const lower = joined.toLowerCase()
  const folded = candidates.flatMap((c, i) => (c.toLowerCase() === lower ? [i] : []))
  if (folded.length > 0) return folded
  const tail = want.map((s) => s.toLowerCase())
  return candidates.flatMap((c, i) => {
    const have = segments(c, separator).map((s) => s.toLowerCase())
    return have.length >= tail.length && tail.every((s, k) => have[have.length - tail.length + k] === s) ? [i] : []
  })
}
