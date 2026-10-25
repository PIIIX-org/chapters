import { isDeepStrictEqual } from 'node:util'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type {
  VerificationTier,
  NoteStatus,
  GeneratedMetadata,
  SourceDescriptor,
  VerifiedMetadata,
  UsageWindow,
  OkfV2Frontmatter,
  OkfNote,
} from './okf/types.js'

export type {
  VerificationTier,
  NoteStatus,
  GeneratedMetadata,
  SourceDescriptor,
  VerifiedMetadata,
  UsageWindow,
  OkfV2Frontmatter,
  OkfNote,
}

export type Frontmatter = OkfV2Frontmatter

export const ISO_8601_OFFSET_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

export function isValidIsoDateTime(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO_8601_OFFSET_REGEX.test(value) &&
    !Number.isNaN(Date.parse(value))
  )
}

export const NOTE_STATUSES: readonly NoteStatus[] = [
  'draft',
  'active',
  'deprecated',
  'superseded',
  'archived',
  'stable',
] as const

export const VERIFICATION_TIERS: readonly VerificationTier[] = [
  'unverified',
  'machine-confirmed',
  'human-reviewed',
] as const

/**
 * The most lists and mappings a frontmatter value may nest (#970): OKF lets
 * producers nest any key (§4.1, §10 `parameters`/`executor`/`attester`); the
 * bound keeps a hostile document from exhausting the stack in the recursive
 * code that measures, compares and writes frontmatter.
 */
export const MAX_FRONTMATTER_DEPTH = 8

/** Whether `value` nests at most `levels` lists or mappings; stops at the bound, so its own recursion is bounded too. */
function nestsWithin(value: unknown, levels: number): boolean {
  if (value === null || typeof value !== 'object') return true
  if (levels === 0) return false
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    if (!nestsWithin(item, levels - 1)) return false
  }
  return true
}

/**
 * Throws unless every top-level value nests at most MAX_FRONTMATTER_DEPTH
 * lists or mappings. Runs before anything walks the whole value.
 */
export function assertFrontmatterDepth(frontmatter: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!nestsWithin(value, MAX_FRONTMATTER_DEPTH)) {
      throw new OkfValidationError(`frontmatter key "${key}" nests more than ${MAX_FRONTMATTER_DEPTH} levels of lists or mappings`)
    }
  }
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/

export function isSlug(value: string): boolean {
  return SLUG.test(value)
}

/** The slug rule of every path segment, `type` and name, as the regex text an error shows (#439). */
export const SLUG_RULE = SLUG.source

/** What an OKF refusal is about (#439): MCP answers it as OKF_INVALID or ALREADY_EXISTS. */
export type OkfRefusal = 'invalid' | 'exists'

/** A note the OKF rules refuse; `rule` is the rule it broke when one names it (the slug regex). */
export class OkfValidationError extends Error {
  constructor(
    message: string,
    readonly refusal: OkfRefusal = 'invalid',
    readonly rule?: string,
  ) {
    super(message)
  }
}

/**
 * `frontmatter` with its OKF `type`: the one it has, or the folder (the
 * path's first segment) when it has none. The frontmatter `type` is free
 * (OKF §4.1, #444); the folder stays in `notes.type`.
 */
export function withType(frontmatter: Record<string, unknown>, folder: string): Frontmatter {
  const type = frontmatter.type
  return { ...frontmatter, type: type === undefined || type === null || type === '' ? folder : type } as Frontmatter
}

/**
 * The shared OKF validation (Editor spec hardening): every write path —
 * REST, CRDT persistence, MCP — validates through here. Slug-only path
 * segments make traversal impossible by construction. It runs before the
 * row or the file is written, so it is also where a note that its own file
 * could not reproduce is refused (see `assertRoundTrips`). `type` is the
 * folder (the path's first segment); the frontmatter `type` may be any
 * non-empty string (#444). Any top-level key may hold a scalar, a list or a
 * mapping, nested at most MAX_FRONTMATTER_DEPTH levels (#970); the known keys
 * below keep their shapes.
 */
export function validateNote(
  type: string,
  name: string,
  frontmatter: Frontmatter,
  body: string,
): void {
  if (!isSlug(type)) throw new OkfValidationError(`invalid type slug: ${type}`, 'invalid', SLUG_RULE)
  const nameSegments = name.split('/')
  if (nameSegments.length === 0 || nameSegments.some((seg) => !isSlug(seg))) {
    throw new OkfValidationError(`invalid name slug: ${name}`, 'invalid', SLUG_RULE)
  }
  assertFrontmatterDepth(frontmatter)
  if (typeof frontmatter.type !== 'string' || frontmatter.type.trim() === '') {
    throw new OkfValidationError('frontmatter type must be a non-empty string')
  }
  if (frontmatter.tags !== undefined) {
    if (
      !Array.isArray(frontmatter.tags) ||
      frontmatter.tags.some((t) => typeof t !== 'string')
    ) {
      throw new OkfValidationError('tags must be an array of strings')
    }
  }
  if (frontmatter.timestamp !== undefined) {
    if (!isValidIsoDateTime(frontmatter.timestamp)) {
      throw new OkfValidationError('timestamp must be an ISO 8601 datetime with explicit UTC/offset')
    }
  }
  if (frontmatter.resource !== undefined && typeof frontmatter.resource !== 'string') {
    throw new OkfValidationError('resource must be a string')
  }
  if (frontmatter.title !== undefined && typeof frontmatter.title !== 'string') {
    throw new OkfValidationError('title must be a string')
  }
  if (frontmatter.description !== undefined && typeof frontmatter.description !== 'string') {
    throw new OkfValidationError('description must be a string')
  }
  if (frontmatter.stale_after !== undefined) {
    if (!isValidIsoDateTime(frontmatter.stale_after)) {
      throw new OkfValidationError('stale_after must be an ISO 8601 datetime with explicit UTC/offset')
    }
  }
  if (frontmatter.status !== undefined) {
    if (!NOTE_STATUSES.includes(frontmatter.status as NoteStatus)) {
      throw new OkfValidationError(`status must be one of: ${NOTE_STATUSES.join(', ')}`)
    }
  }
  if (frontmatter.generated !== undefined) {
    if (
      typeof frontmatter.generated !== 'object' ||
      frontmatter.generated === null ||
      Array.isArray(frontmatter.generated) ||
      typeof frontmatter.generated.by !== 'string' ||
      !isValidIsoDateTime(frontmatter.generated.at)
    ) {
      throw new OkfValidationError(
        'generated must be an object with string "by" and ISO 8601 datetime "at"',
      )
    }
  }
  if (frontmatter.sources !== undefined) {
    if (!Array.isArray(frontmatter.sources)) {
      throw new OkfValidationError('sources must be an array of objects')
    }
    for (const source of frontmatter.sources) {
      if (
        typeof source !== 'object' ||
        source === null ||
        Array.isArray(source) ||
        typeof source.resource !== 'string'
      ) {
        throw new OkfValidationError('sources items must be objects with a string "resource"')
      }
      if (source.last_modified !== undefined && !isValidIsoDateTime(source.last_modified)) {
        throw new OkfValidationError(
          'sources item last_modified must be an ISO 8601 datetime with explicit UTC/offset',
        )
      }
    }
  }
  if (frontmatter.verified !== undefined) {
    // OKF §5.2: verification events `{ by, at }`, the tier derived from `by`
    // (§5.3), so `tier` is optional (#563). Elara's own `{ tier }` entries
    // stay valid; an entry with neither a tier nor `by` and `at` says nothing.
    const message = `verified must be a { by, at } object or a list of them (by an actor string, at an ISO 8601 datetime with explicit UTC/offset; optional tier in: ${VERIFICATION_TIERS.join(', ')})`
    if (typeof frontmatter.verified !== 'object' || frontmatter.verified === null) {
      throw new OkfValidationError(message)
    }
    const items: unknown[] = Array.isArray(frontmatter.verified) ? frontmatter.verified : [frontmatter.verified]
    for (const item of items) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new OkfValidationError(message)
      const { tier, by, at } = item as Record<string, unknown>
      if (
        (tier !== undefined && !VERIFICATION_TIERS.includes(tier as VerificationTier)) ||
        (by !== undefined && typeof by !== 'string') ||
        (at !== undefined && !isValidIsoDateTime(at)) ||
        (tier === undefined && (by === undefined || at === undefined))
      ) {
        throw new OkfValidationError(message)
      }
    }
  }
  if (frontmatter.usage_window !== undefined) {
    if (
      typeof frontmatter.usage_window !== 'object' ||
      frontmatter.usage_window === null ||
      Array.isArray(frontmatter.usage_window) ||
      !isValidIsoDateTime(frontmatter.usage_window.from) ||
      (frontmatter.usage_window.to !== undefined && !isValidIsoDateTime(frontmatter.usage_window.to))
    ) {
      throw new OkfValidationError(
        'usage_window must be an object with ISO 8601 datetime "from" and optional ISO 8601 datetime "to"',
      )
    }
  }
  if (frontmatter.properties !== undefined) {
    if (
      typeof frontmatter.properties !== 'object' ||
      frontmatter.properties === null ||
      Array.isArray(frontmatter.properties)
    ) {
      throw new OkfValidationError('properties must be an object')
    }
  }
  if (typeof body !== 'string') throw new OkfValidationError('body must be a string')
  assertRoundTrips(frontmatter, body)
}

/**
 * The file is the canonical copy of a note (readNote, the collab load), so a
 * note whose serialized file does not parse back to the same frontmatter and
 * body must never be written: it would be stored as something else and every
 * later read, edit or collab session would carry the corruption forward.
 */
function assertRoundTrips(frontmatter: Frontmatter, body: string): void {
  let parsed: OkfNote
  try {
    parsed = parseNote(serializeNote({ frontmatter, body }))
  } catch (err) {
    throw new OkfValidationError(
      `note cannot be stored: its file would not parse (${err instanceof Error ? err.message : String(err)})`,
    )
  }
  if (!isDeepStrictEqual(parsed.frontmatter, frontmatter)) {
    throw new OkfValidationError('note cannot be stored: its frontmatter does not survive serialization')
  }
  if (parsed.body !== body) {
    throw new OkfValidationError('note cannot be stored: its body does not survive serialization')
  }
}

export function serializeNote(note: OkfNote): string {
  return `---\n${stringifyYaml(note.frontmatter)}---\n${note.body}`
}

/**
 * Frontmatter is everything between an opening `---` line and the first line
 * that is exactly `---` (trailing spaces/tabs allowed). Both fences must be
 * whole lines: a `---` inside a value (`title: alpha---beta`, a block scalar
 * line, a list item) or in the body is content, not a fence. LF and CRLF
 * files both parse; the body is returned verbatim after the closing fence's
 * line break.
 */
const NOTE_FENCES = /^---\r?\n(?:|([\s\S]*?)\r?\n)---[ \t]*(?:\r?\n|$)([\s\S]*)$/

export function parseNote(raw: string): OkfNote {
  const match = raw.match(NOTE_FENCES)
  if (!match) throw new OkfValidationError('missing frontmatter fence')
  const frontmatter = parseYaml(match[1] ?? '') as Frontmatter
  if (typeof frontmatter !== 'object' || frontmatter === null || Array.isArray(frontmatter)) {
    throw new OkfValidationError('frontmatter must be a YAML mapping')
  }
  return { frontmatter, body: match[2] ?? '' }
}

/** The most code points a link's `context` holds (#472). */
export const LINK_CONTEXT_MAX = 200

/**
 * A `[[wikilink]]` of a note body: its target, the body lines (1-based,
 * inclusive) it is written on, and its `context` (#472): the paragraph it is
 * in (the non-blank lines around it) when that is at most `LINK_CONTEXT_MAX`
 * code points, else its own lines when they are, else that many code points
 * of its lines around it, `…` marking each cut end. Line ends lose their `\r`.
 */
export interface WikilinkLocation {
  target: string
  startLine: number
  endLine: number
  context: string
}

const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff
const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff

/**
 * `text` cut to `LINK_CONTEXT_MAX` code points around [from, to) (UTF-16
 * offsets): the link first, then a code point before and after it in turn;
 * an ellipsis takes the place of the outermost code point at each cut end.
 * Never splits a surrogate pair; O(LINK_CONTEXT_MAX) whatever the text's length.
 */
function contextWindow(text: string, from: number, to: number): string {
  const before = (at: number) => (at >= 2 && isLow(text.charCodeAt(at - 1)) && isHigh(text.charCodeAt(at - 2)) ? 2 : 1)
  const after = (at: number) => (isHigh(text.charCodeAt(at)) && isLow(text.charCodeAt(at + 1)) ? 2 : 1)
  let start = from
  let end = from
  let n = 0
  for (; end < to && n < LINK_CONTEXT_MAX; n++) end += after(end)
  for (let left = true; n < LINK_CONTEXT_MAX && (start > 0 || end < text.length); n++, left = !left) {
    if ((left && start > 0) || end >= text.length) start -= before(start)
    else end += after(end)
  }
  if (start > 0) start += after(start)
  if (end < text.length) end -= before(end)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

/** Whether `text` has at most `LINK_CONTEXT_MAX` code points (a UTF-16 length over twice that never does). */
function fits(text: string): boolean {
  if (text.length <= LINK_CONTEXT_MAX) return true
  if (text.length > 2 * LINK_CONTEXT_MAX) return false
  let n = 0
  for (let i = 0; i < text.length; i++) if (!isLow(text.charCodeAt(i)) || !isHigh(text.charCodeAt(i - 1))) n++
  return n <= LINK_CONTEXT_MAX
}

/** Every `[[wikilink]]` of a note body, in document order (a target linked twice is listed twice). */
export function extractWikilinkLocations(body: string): WikilinkLocation[] {
  // ponytail: ignore code blocks, inline backticks, and HTML comments to prevent phantom graph edges (GRAPH-09).
  // They are blanked (line breaks kept), not removed, so offsets and line numbers stay those of `body`.
  const blank = (text: string) => text.replace(/[^\n]/g, ' ')
  const stripped = body
    .replace(/```[\s\S]*?```/g, blank)
    .replace(/`[^`\n]+`/g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
  const matches = [...stripped.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].filter((m) => m[1]!.trim() !== '')
  if (matches.length === 0) return []
  // Line i (0-based) is body[starts[i], ends[i]) without its `\r`; a paragraph runs from first[i] to last[i].
  const starts = [0]
  for (let i = body.indexOf('\n'); i !== -1; i = body.indexOf('\n', i + 1)) starts.push(i + 1)
  const ends = starts.map((s, i) => (i + 1 < starts.length ? starts[i + 1]! - 1 : body.length))
  for (let i = 0; i < ends.length; i++) if (ends[i]! > starts[i]! && body.charCodeAt(ends[i]! - 1) === 13) ends[i]!--
  const isBlank = starts.map((s, i) => body.slice(s, ends[i]).trim() === '')
  const first = new Array<number>(starts.length)
  const last = new Array<number>(starts.length)
  for (let i = 0; i < starts.length; i++) first[i] = !isBlank[i] && i > 0 && !isBlank[i - 1] ? first[i - 1]! : i
  for (let i = starts.length - 1; i >= 0; i--) last[i] = !isBlank[i] && i + 1 < starts.length && !isBlank[i + 1] ? last[i + 1]! : i
  const lines = (a: number, b: number) => {
    const parts: string[] = []
    for (let i = a; i <= b; i++) parts.push(body.slice(starts[i], ends[i]))
    return parts.join('\n')
  }

  const links: WikilinkLocation[] = []
  let line = 0
  for (const match of matches) {
    while (line + 1 < starts.length && starts[line + 1]! <= match.index) line++
    const endLine = line + match[0].split('\n').length - 1
    const [a, b] = [first[line]!, last[endLine]!]
    // A paragraph over 4 × the cap in UTF-16 units is taken as too long without reading it.
    const paragraph = ends[b]! - starts[a]! <= 4 * LINK_CONTEXT_MAX ? lines(a, b).trim() : null
    let context: string
    if (paragraph !== null && fits(paragraph)) {
      context = paragraph
    } else {
      const own = lines(line, endLine)
      // Its first line keeps everything before the link (only line ends lost their `\r`).
      const at = match.index - starts[line]!
      context = fits(own.trim()) ? own.trim() : contextWindow(own, at, Math.min(own.length, at + match[0].length))
    }
    links.push({ target: match[1]!.trim(), startLine: line + 1, endLine: endLine + 1, context })
  }
  return links
}

/** The distinct `[[wikilink]]` targets of a note body (for the graph engine and the audit). */
export function extractWikilinks(body: string): string[] {
  return [...new Set(extractWikilinkLocations(body).map((l) => l.target))]
}
