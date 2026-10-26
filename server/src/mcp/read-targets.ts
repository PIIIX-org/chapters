/**
 * Targeted and outline reads for read_note and read_file (#416, #417;
 * ADR-004 §2.1, §2.2).
 *
 * - `targets` reads parts of a document in one call, in request order:
 *   `{lines: "a-b"}`, `{block: "b_…"}`, `{heading: "A > B"}` and (files)
 *   `{symbol: "Class.method"}`. Each is a `part` text section of the
 *   envelope (response.ts), so it is cut at line boundaries within the
 *   budget, its `next` names what a page left, and the cursor continues
 *   there. A target that names nothing is an item with an `error` (the
 *   error envelope's object, #439: NOT_FOUND with the nearest headings or
 *   symbols as `suggestions`, AMBIGUOUS, or INVALID_ARGUMENT); the call
 *   succeeds. A result handle (#423) becomes one more kind here.
 * - The outline (#417) is the document's headings or symbols with their
 *   block ids, lines and approximate tokens: what a read answers when the
 *   whole answer would not fit its budget, or when asked (`outline: true`).
 *   It is the reads' `locations` level: the body is withheld, and the
 *   cursor pages it from its first line.
 * - `if_rev` (#682, ADR-004 §2.9) is the version an earlier answer gave: a
 *   note's `rev`, a file's `hash`. While it is current, any read (body,
 *   targets or outline) answers `unchanged` in a few tokens instead.
 *
 * Lines are those of the document as read: a note's projected file (D3,
 * line 1 is `---`), a repository file's content.
 */
import { z } from 'zod'
import { noteBlocks } from '../notes/note-blocks.js'
import { lineStarts } from '../text/lines.js'
import { headingSections, matchPath, parseLineSpec, segments, wholeLines, type LineRange } from '../text/targets.js'
import { McpToolError, envelope, type ErrorEnvelope } from './errors.js'
import { location, ranked, textSection, type Budgeted, type CursorAt, type Section } from './response.js'
import { editDistance, strictArgs } from './strict-input.js'

/** Most targets one read takes (checked by `checkReadArgs`, not in the schema: tools/list pays for every keyword). */
export const MAX_TARGETS = 20

export type TargetKind = 'lines' | 'block' | 'heading' | 'symbol'
export type Target = Partial<Record<TargetKind, string>>

/** The `targets` argument of `tool`, with the target kinds it reads. */
export function targetsArg(tool: string, kinds: readonly TargetKind[]) {
  return z
    .array(strictArgs(`${tool} targets[]`, Object.fromEntries(kinds.map((kind) => [kind, z.string().optional()]))))
    .optional()
    .describe('Parts to read')
}

/** A document targets resolve in; every line range is in the numbering of `text`. */
export interface TargetDocument {
  text: string
  /** The blocks a `block` target can name. */
  blocks: ReadonlyArray<{ block: string; lines: LineRange }>
  /** Heading sections (`path`: titles joined with ` > `), or why this document has none. */
  headings: ReadonlyArray<{ path: string; lines: LineRange }> | string
  /** Symbols (`path`: `Class.method`), or why this document has none. */
  symbols: ReadonlyArray<{ path: string; lines: LineRange }> | string
}

const KINDS: readonly TargetKind[] = ['lines', 'block', 'heading', 'symbol']

/** How many candidates an ambiguous heading or symbol suggests. */
const AMBIGUOUS_SHOWN = 5

type Resolved = { part: Record<string, unknown>; lines: LineRange } | { error: ErrorEnvelope }

/** One `part` text section per target, in request order (response.ts `TextSection.part`). */
export function targetSections(doc: TargetDocument, targets: readonly Target[]): Section[] {
  const starts = lineStarts(doc.text)
  // Suggestions for every target of this read share one bounded amount of edit-distance work.
  const work = { cells: SUGGESTION_CELLS }
  return targets.map((target) => {
    const resolved = resolve(doc, target, starts.length, work)
    if ('error' in resolved) return textSection({ name: 'targets', text: '', lines: false, part: { ...target, error: resolved.error } })
    const [a, b] = resolved.lines
    return textSection({ name: 'targets', text: wholeLines(doc.text, a, b, starts), lines: true, firstLine: a, part: resolved.part })
  })
}

function resolve(doc: TargetDocument, target: Target, total: number, work: { cells: number }): Resolved {
  const kinds = KINDS.filter((kind) => target[kind] !== undefined)
  if (kinds.length !== 1) return { error: envelope('INVALID_ARGUMENT', 'a target names one of lines, block, heading or symbol') }
  const kind = kinds[0]!
  const value = target[kind]!
  if (kind === 'lines') {
    const spec = parseLineSpec(value)
    if (!spec) return { error: envelope('INVALID_ARGUMENT', 'lines is "a-b", "a" or "a-" (1-based, a <= b)') }
    if (spec.start > total) return { error: envelope('NOT_FOUND', `line ${spec.start} is past the end (total_lines ${total})`) }
    return { part: {}, lines: [spec.start, Math.min(spec.end ?? total, total)] }
  }
  if (kind === 'block') {
    const found = doc.blocks.find((b) => b.block === value)
    return found ? { part: { block: value }, lines: found.lines } : { error: envelope('NOT_FOUND', 'block not found in this document; `outline: true` lists its blocks') }
  }
  return kind === 'heading' ? named(value, doc.headings, '>', 'heading', work) : named(value, doc.symbols, '.', 'symbol', work)
}

/** A heading or symbol path resolved among `list` (text/targets.ts `matchPath`). */
function named(wanted: string, list: TargetDocument['headings'], separator: string, kind: 'heading' | 'symbol', work: { cells: number }): Resolved {
  if (typeof list === 'string') return { error: envelope('NOT_FOUND', list) }
  const paths = list.map((entry) => entry.path)
  const hits = matchPath(wanted, paths, separator)
  if (hits.length === 0) return { error: envelope('NOT_FOUND', `${kind} not found`, { suggestions: nearestPaths(wanted, paths, separator, work) }) }
  if (hits.length > 1) {
    const candidates = hits.map((i) => list[i]!)
    // The same path twice (two `## Notes`, overloads): only their lines tell them apart.
    const distinct = new Set(candidates.map((c) => c.path)).size === candidates.length
    const suggestions = candidates.slice(0, AMBIGUOUS_SHOWN).map((c) => (distinct ? c.path : `lines: "${c.lines[0]}-${c.lines[1]}"`))
    return { error: envelope('AMBIGUOUS', `${kind} names ${hits.length} ${kind === 'heading' ? 'sections' : 'symbols'}`, { suggestions }) }
  }
  const hit = list[hits[0]!]!
  return { part: { [kind]: hit.path }, lines: hit.lines }
}

/** A longer heading or symbol path gets no suggestions, as an overlong unknown argument gets none (#769). */
const MAX_WANTED = 120
/** Paths compared for suggestions are cut to this many characters. */
const MAX_COMPARED = 120
/** Paths compared by edit distance per target, the first after the cheap tiers (then in document order). */
const MAX_DISTANCES = 200
/** Edit-distance cells (`editDistance` fills one per character pair) one read spends on suggestions, all targets together. */
export const SUGGESTION_CELLS = 1_000_000
const SUGGESTED = 3

/**
 * The paths nearest `wanted`, nearest first: the same last segment, then
 * one containing the other (both by a linear check over every path), then
 * by edit distance (case-insensitive) among the first MAX_DISTANCES of
 * those tiers while `work` lasts, then in document order. The work is
 * bounded: a note with thousands of headings and a read of 20 missing
 * targets stays within SUGGESTION_CELLS. Empty when there are no paths or
 * `wanted` is over MAX_WANTED.
 */
export function nearestPaths(wanted: string, paths: readonly string[], separator: string, work: { cells: number }): string[] {
  if (wanted.length > MAX_WANTED) return []
  const want = wanted.toLowerCase()
  const last = segments(want, separator).at(-1) ?? want
  return [...new Set(paths)]
    .map((value, order) => {
      const have = value.slice(0, MAX_COMPARED).toLowerCase()
      const tier = (segments(have, separator).at(-1) ?? have) === last ? 0 : have.includes(want) || want.includes(have) ? 1 : 2
      return { value, order, tier, have }
    })
    .sort((a, b) => a.tier - b.tier || a.order - b.order)
    .slice(0, MAX_DISTANCES)
    .map((c) => {
      const cells = (want.length + 1) * (c.have.length + 1)
      if (work.cells < cells) return { ...c, distance: Infinity }
      work.cells -= cells
      return { ...c, distance: editDistance(want, c.have) }
    })
    .sort((a, b) => a.tier - b.tier || a.distance - b.distance || a.order - b.order)
    .slice(0, SUGGESTED)
    .map((c) => c.value)
}

/**
 * One section or symbol of an outline: `heading` or `symbol` (with its
 * `kind`) names it, none a note's preamble. `block` is the block whose
 * lines are exactly the entry's: left out for a text one block does not
 * hold (over NOTE_CHUNK_CHARS of its own, note-blocks.ts).
 */
export interface OutlineEntry {
  block?: string
  heading?: string
  symbol?: string
  kind?: string
  lines: LineRange
  /** About what reading its lines costs (characters / 4, response.ts `approxTokens`). */
  tokens: number
}

/** `approxTokens` of lines a..b of the text whose `lineStarts` is `starts`, without slicing it. */
export function rangeTokens(text: string, starts: readonly number[], [a, b]: LineRange): number {
  return Math.ceil(((b < starts.length ? starts[b]! : text.length) - starts[a - 1]!) / 4)
}

/**
 * The outline as a list of the envelope: entries in document order; down
 * the ladder without `tokens` and `kind`, then each as `<block or name>#La-Lb`;
 * counted per kind. Null (a read answering its body): the answer has no
 * `outline` key. Always the read's first section, so a cursor at section 0
 * is an outline page and one past it a body page.
 */
export function outlineSection(entries: readonly OutlineEntry[] | null): Section {
  return ranked({
    name: 'outline',
    items: entries ?? [],
    id: (e) => `${e.lines[0]}-${e.lines[1]}:${e.block ?? e.heading ?? e.symbol ?? ''}`,
    omitEmpty: entries === null,
    ladder: {
      no_context: ({ block, heading, symbol, lines }) => ({ ...(block === undefined ? {} : { block }), ...(heading === undefined ? {} : { heading }), ...(symbol === undefined ? {} : { symbol }), lines }),
      locations: (e) => location(e.block ?? e.heading ?? e.symbol ?? '', e.lines[0], e.lines[1]),
      group: (e) => e.kind ?? (e.heading === undefined ? 'preamble' : 'section'),
    },
  })
}

/**
 * The outline a read answers, or null when it answers its body (#417): only
 * with `outline: true`, and on its own pages (a cursor at section 0; any
 * other cursor is a body page). Opt-in: answering a body over the budget
 * with its outline by default cost the premise benchmark's agent more on
 * every suite and lost a gold (#1002), so a read without `outline` pages
 * the body as before.
 */
export async function outlineFirst(
  outline: boolean | undefined,
  at: CursorAt | null,
  entries: () => Promise<OutlineEntry[]> | OutlineEntry[],
): Promise<OutlineEntry[] | null> {
  return (at === null ? outline === true : at.s === 0) ? entries() : null
}

/** What an outline answer suggests next: its first named entry as a target, or the body by pages. */
export function outlineNarrow(entries: readonly OutlineEntry[]): string[] {
  const first = entries.find((e) => e.heading !== undefined || e.symbol !== undefined)
  const target = first?.heading !== undefined ? { heading: first.heading } : first?.symbol !== undefined ? { symbol: first.symbol } : null
  return [...(target ? [`targets: [${JSON.stringify(target)}]`] : []), 'outline: false']
}

/** A read's outline and what its targets resolve in, besides the text. */
export type DocumentParts = Omit<TargetDocument, 'text'> & { outline: OutlineEntry[] }

/** Repository files whose headings are read like a note's. */
export const MARKDOWN_PATH = /\.(md|markdown|mdx)$/i

/**
 * A note body, or a markdown file, as `text` shows it from line `offset` + 1
 * (a note's `body_start_line` - 1, D3): its blocks (note-blocks.ts, the ids
 * the `blocks` table and search hits carry, computed on the text read, so
 * they always match it), its heading sections, and the blocks as its
 * outline. `ownerId`: the note's or the file's id.
 */
export function markdownParts(ownerId: string, path: string, body: string, text: string, offset: number): Omit<DocumentParts, 'symbols'> {
  const starts = lineStarts(text)
  const shift = ([a, b]: LineRange): LineRange => [a + offset, b + offset]
  // A blank body without headings is one preamble spanning no line: nothing to read or list.
  const found = noteBlocks(ownerId, path, body).filter((b) => b.endLine >= b.startLine)
  const headings = headingSections(body)
  const entry = (lines: LineRange, block: string | undefined, heading?: string): OutlineEntry => ({
    ...(block === undefined ? {} : { block }),
    ...(heading === undefined ? {} : { heading }),
    lines: shift(lines),
    tokens: rangeTokens(text, starts, shift(lines)),
  })
  // One entry per heading section, and the preamble, with the block that spans exactly its lines. A text over
  // NOTE_CHUNK_CHARS is several blocks (note-blocks.ts): its entry has no `block`, `heading` and `lines` read it.
  const preamble = found.filter((b) => b.kind === 'preamble')
  const outline = preamble.length === 0 ? [] : [entry([preamble[0]!.startLine, preamble.at(-1)!.endLine], preamble.length === 1 ? preamble[0]!.blockId : undefined)]
  const sectionBlock = new Map(found.flatMap((b) => (b.kind === 'section' ? [[`${b.startLine}-${b.endLine}`, b.blockId] as const] : [])))
  for (const h of headings) outline.push(entry(h.lines, sectionBlock.get(`${h.lines[0]}-${h.lines[1]}`), h.path))
  return {
    blocks: found.map((b) => ({ block: b.blockId, lines: shift([b.startLine, b.endLine]) })),
    headings: headings.map((h) => ({ path: h.path, lines: shift(h.lines) })),
    outline,
  }
}

/** A code file's blocks (repositories/store.ts `listFileBlocks`, current content only), its symbols and their outline. */
export function codeParts(
  rows: ReadonlyArray<{ blockId: string; kind: string; innerPath: string; symbolKind: string | null; startLine: number; endLine: number }>,
  text: string,
): { blocks: TargetDocument['blocks']; symbols: Array<{ path: string; lines: LineRange }>; outline: OutlineEntry[] } {
  const starts = lineStarts(text)
  const spans = rows.filter((r) => r.endLine >= r.startLine)
  const symbols = spans.filter((r) => r.kind === 'symbol')
  return {
    blocks: spans.map((r) => ({ block: r.blockId, lines: [r.startLine, r.endLine] })),
    symbols: symbols.map((r) => ({ path: r.innerPath, lines: [r.startLine, r.endLine] })),
    outline: symbols.map((r) => ({
      block: r.blockId,
      symbol: r.innerPath,
      ...(r.symbolKind === null ? {} : { kind: r.symbolKind }),
      lines: [r.startLine, r.endLine],
      tokens: rangeTokens(text, starts, [r.startLine, r.endLine]),
    })),
  }
}

/** One to MAX_TARGETS targets; and `targets` reads parts while `outline: true` answers the outline: one call does one of them. */
export function checkReadArgs(args: { targets?: readonly unknown[]; outline?: boolean }): void {
  if (args.targets !== undefined && (args.targets.length === 0 || args.targets.length > MAX_TARGETS)) {
    throw new McpToolError('INVALID_ARGUMENT', `targets names 1 to ${MAX_TARGETS} parts; got ${args.targets.length}`, { field: 'targets' })
  }
  if (args.targets !== undefined && args.outline === true) {
    throw new McpToolError('INVALID_ARGUMENT', 'send targets (parts) or outline: true (the outline), not both', { field: 'outline' })
  }
}

/** The `outline` argument (#417): true answers the outline, false pages the body; by default a body over the budget answers its outline. */
export const OUTLINE_ARG = z.boolean().optional().describe('true: outline only')

/**
 * The `if_rev` argument (#682) of a read whose answers carry `version` (read_note `rev`, read_file `hash`). Coerced, so
 * the integer `rev` an answer gives works as sent; tools/list still says `string`.
 */
export const ifRevArg = (version: 'rev' | 'hash') => z.coerce.string().optional().describe(`Your \`${version}\`: if current, answers \`unchanged\``)

/** The answer to a read whose `if_rev` is current (#682): `{unchanged: true, rev | hash}` and, as every budgeted answer, `truncated: false`. */
export function unchanged(version: { rev: number } | { hash: string }): Budgeted {
  return { head: { unchanged: true, ...version }, sections: [] }
}
