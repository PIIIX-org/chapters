/**
 * Heading outlines of a repository's Markdown and HTML files (#464): one
 * section per heading, from its line through the line before the next
 * heading of the same or a higher level (a nested section overlaps its
 * parent, as a note's do), named by the heading titles from the top level
 * down joined with ` > ` (a note section's `inner_path`). code-blocks.ts makes
 * each one a `section` block: an outline block, never embedded and not a
 * symbol, so find_symbols and read_file's outline never list them. Pure; versioned by
 * extraction.ts `EXTRACTOR_VERSION`.
 */
import { headings } from '../text/blocks.js'
import { lineStarts } from '../text/lines.js'

export interface OutlineSection {
  innerPath: string
  /** The heading's line; 1-based. */
  startLine: number
  /** The line before the next heading (or the last line): the section's own text. */
  ownEndLine: number
  /** The line before the next heading of the same or a higher level (or the last line). */
  endLine: number
}

interface FoundHeading {
  level: number
  title: string
  line: number
}

/**
 * Bounds for outlines built per call (ref/overlay views); the live index passes none, so its sections are unchanged.
 * Each title segment is cut to `title` characters and a section's path to `path`; a file with more than `sections` headings gets no
 * outline at all (as a minified file gets no symbols); `charge` is told the bytes of each section's path and object before they are
 * built, and may throw to refuse the request.
 */
export interface OutlineLimits {
  title: number
  path: number
  sections: number
  charge: (bytes: number) => void
}

/** Bytes charged for a section beyond its path: the object, its numbers and the block it becomes. */
const SECTION_OVERHEAD = 512

/** `text` cut to `max` UTF-16 units without leaving half of a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text
  const end = max > 0 && text.charCodeAt(max - 1) >= 0xd800 && text.charCodeAt(max - 1) <= 0xdbff ? max - 1 : max
  return text.slice(0, end)
}

export function hasOutline(language: string | null): boolean {
  return language === 'markdown' || language === 'html'
}

export function outlineSections(language: string | null, content: string, limits?: OutlineLimits): OutlineSection[] {
  const starts = lineStarts(content)
  const found = language === 'markdown' ? markdownHeadings(content, starts, limits?.sections) : language === 'html' ? htmlHeadings(content, starts, limits?.sections) : []
  if (limits && found.length > limits.sections) return []
  const total = starts.length
  const trail: FoundHeading[] = []
  // The next heading of the same or a higher level, for each heading, in one pass: a heading waits on the stack until
  // a heading of its level or above arrives (the stack holds strictly rising levels, so at most six entries wait).
  const nextOf: number[] = new Array<number>(found.length).fill(-1)
  const waiting: number[] = []
  found.forEach((h, i) => {
    while (waiting.length > 0 && found[waiting.at(-1)!]!.level >= h.level) nextOf[waiting.pop()!] = i
    waiting.push(i)
  })
  return found.map((h, i) => {
    while (trail.length > 0 && trail.at(-1)!.level >= h.level) trail.pop()
    trail.push(limits ? { ...h, title: cut(h.title, limits.title) } : h)
    const next = nextOf[i]!
    // The path's length is known from the segments before any of it is joined.
    let path: string
    if (limits) {
      limits.charge(Math.min(limits.path, trail.reduce((n, t) => n + t.title.length, 0) + 3 * (trail.length - 1)) + SECTION_OVERHEAD)
      path = cut(trail.map((t) => t.title).join(' > '), limits.path)
    } else path = trail.map((t) => t.title).join(' > ')
    // Two HTML headings can share a line: a section always spans its own.
    const before = (line: number | undefined) => Math.max(h.line, line === undefined ? total : line - 1)
    return {
      innerPath: path,
      startLine: h.line,
      ownEndLine: before(found[i + 1]?.line),
      endLine: before(next === -1 ? undefined : found[next]!.line),
    }
  })
}

/** The 1-based line of an offset. */
function lineAt(starts: number[], offset: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/** ATX headings (text/blocks.ts `headings`, so none in a code fence) after a leading `---` front matter block. */
function markdownHeadings(content: string, starts: number[], max?: number): FoundHeading[] {
  const frontMatter = /^---\r?\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(content)
  const from = frontMatter ? frontMatter[0].length : 0
  return headings(content.slice(from), max).map((h) => ({ level: h.level, title: h.title, line: lineAt(starts, from + h.start) }))
}

/** What no heading is read inside: comments, scripts, styles. Blanked (newlines kept) so offsets stay lines. */
const HTML_OPAQUE = /<!--[\s\S]*?(?:-->|$)|<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi
/** `<h1>`..`<h6>` through its closing tag, its text at most a few thousand characters (an unclosed one is skipped). */
const HTML_HEADING = /<h([1-6])\b[^>]*>([\s\S]{0,4000}?)<\/h\1\s*>/gi
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] !== '#') return ENTITIES[body.toLowerCase()] ?? entity
    const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity
  })
}

/** HTML `h1`-`h6` with their text: tags dropped, entities decoded, white space collapsed; empty ones skipped. */
function htmlHeadings(content: string, starts: number[], max = Infinity): FoundHeading[] {
  const visible = content.replace(HTML_OPAQUE, (opaque) => opaque.replace(/[^\n]/g, ' '))
  const out: FoundHeading[] = []
  for (const match of visible.matchAll(HTML_HEADING)) {
    const title = decodeEntities(match[2]!.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
    if (title) out.push({ level: Number(match[1]), title, line: lineAt(starts, match.index) })
    if (out.length > max) break
  }
  return out
}
