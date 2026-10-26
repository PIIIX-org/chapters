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

export function hasOutline(language: string | null): boolean {
  return language === 'markdown' || language === 'html'
}

export function outlineSections(language: string | null, content: string): OutlineSection[] {
  const starts = lineStarts(content)
  const found = language === 'markdown' ? markdownHeadings(content, starts) : language === 'html' ? htmlHeadings(content, starts) : []
  const total = starts.length
  const trail: FoundHeading[] = []
  return found.map((h, i) => {
    while (trail.length > 0 && trail.at(-1)!.level >= h.level) trail.pop()
    trail.push(h)
    const next = found.findIndex((o, j) => j > i && o.level <= h.level)
    // Two HTML headings can share a line: a section always spans its own.
    const before = (line: number | undefined) => Math.max(h.line, line === undefined ? total : line - 1)
    return {
      innerPath: trail.map((t) => t.title).join(' > '),
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
function markdownHeadings(content: string, starts: number[]): FoundHeading[] {
  const frontMatter = /^---\r?\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(content)
  const from = frontMatter ? frontMatter[0].length : 0
  return headings(content.slice(from)).map((h) => ({ level: h.level, title: h.title, line: lineAt(starts, from + h.start) }))
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
function htmlHeadings(content: string, starts: number[]): FoundHeading[] {
  const visible = content.replace(HTML_OPAQUE, (opaque) => opaque.replace(/[^\n]/g, ' '))
  const out: FoundHeading[] = []
  for (const match of visible.matchAll(HTML_HEADING)) {
    const title = decodeEntities(match[2]!.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
    if (title) out.push({ level: Number(match[1]), title, line: lineAt(starts, match.index) })
  }
  return out
}
