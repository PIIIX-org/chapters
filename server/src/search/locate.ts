// Where a search hit points (#414): the passage of the note or file, not the document. For the hits a search
// returns (at most its `limit`, so a few documents), `locateHits` fills `block`, `heading`, `startLine`/`endLine`
// (the lines `read_note` and `read_file` take: a note's are lines of its file, ADR-004 §2.2 D3), `tokens` (what
// reading that span costs) and a snippet of up to `SNIPPET_CHARS` characters around the match.
//
// A note hit points at the block its vector leg found nearest, or else at the innermost block around the best
// match of the query's terms in its text; a code file hit at the innermost symbol around that match; a symbol hit
// is its own span. The best match is the line with the most distinct terms within a few lines of it. A document
// over `LOCATE_MAX_CHARS` is not read (its hit keeps the document-level fields), so the cost of a search stays
// bounded; nothing here ranks or filters.
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { bodyStartLine } from '../notes/projector.js'
import { lineStarts } from '../text/lines.js'
import { splitIdentifier } from './identifiers.js'
import type { SearchResult } from './search.js'

/** The length a snippet is cut at: a hit shows the passage around the match, not a document. */
export const SNIPPET_CHARS = 200
/** A document longer than this is not read to locate a hit in it. */
export const LOCATE_MAX_CHARS = 262_144
/** Lines either side of a line whose terms count with it. */
const NEAR_LINES = 6
/** Occurrences of one term kept: the search is for a place, not a count. */
const MAX_OCCURRENCES = 200
/** Words of a question that say nothing about where the answer is. */
const FILLER = new Set(
  'about after also and are been before between both can could does each for from has have how into its not only other should that the their them then there these they this those use used uses using was were what when where which while who why will with would'.split(' '),
)

/** The terms of a query to look for in a text, lower case: its identifiers (and their parts), then its other words. */
export function matchTerms(query: string): string[] {
  const found = new Set<string>()
  for (const raw of query.split(/\s+/)) {
    const word = raw.replace(/^[^\p{L}\p{N}_$/.-]+|[^\p{L}\p{N}_$/.-]+$/gu, '')
    if (word.length < 3) continue
    const lower = word.toLowerCase()
    if (/[_$/.]|\p{Ll}\p{Lu}|^\p{Lu}{2,}/u.test(word)) {
      found.add(lower)
      for (const part of splitIdentifier(word).parts) if (part.length >= 4 && !FILLER.has(part)) found.add(part)
    } else if (word.length >= 4 && !FILLER.has(lower)) {
      found.add(lower)
    }
  }
  return [...found]
}

interface Place {
  /** 1-based line of the text the hit points at. */
  line: number
  /** Index of the match the snippet is cut around. */
  at: number
}

/** The place with the most distinct terms within `NEAR_LINES` lines; the earliest of equals. Null when no term occurs. */
export function bestPlace(text: string, starts: readonly number[], terms: readonly string[]): Place | null {
  if (terms.length === 0 || text === '') return null
  const lower = text.toLowerCase()
  const lineOf = (index: number): number => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid]! <= index) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
  const hits: Array<{ line: number; term: number; at: number }> = []
  terms.forEach((term, t) => {
    let at = lower.indexOf(term)
    for (let n = 0; at !== -1 && n < MAX_OCCURRENCES; n++, at = lower.indexOf(term, at + term.length)) hits.push({ line: lineOf(at), term: t, at })
  })
  if (hits.length === 0) return null
  hits.sort((a, b) => a.at - b.at)
  let best: { score: number; hit: (typeof hits)[number] } | null = null
  for (const hit of hits) {
    const near = new Set<number>()
    for (const other of hits) if (Math.abs(other.line - hit.line) <= NEAR_LINES) near.add(other.term)
    if (best === null || near.size > best.score) best = { score: near.size, hit }
  }
  return { line: best!.hit.line, at: best!.hit.at }
}

/**
 * `SNIPPET_CHARS` characters of `text` around `at`, cut at word edges, with the terms in it marked `<b>...</b>` as
 * `ts_headline` marked them (the marks are not counted in the 200).
 */
export function snippetAround(text: string, at: number, terms: readonly string[] = []): string {
  const start = Math.max(0, at - Math.floor(SNIPPET_CHARS * 0.4))
  const raw = text.slice(start, start + SNIPPET_CHARS)
  const cut = (start > 0 ? raw.replace(/^\S*\s/, '') : raw).trim()
  if (terms.length === 0) return cut
  const marked = new RegExp(terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi')
  return cut.replace(marked, '<b>$&</b>')
}

/** Lines `a`..`b` of a text whose `lineStarts` is `starts`, as the characters they hold, over 4: what reading them costs. */
const spanTokens = (text: string, starts: readonly number[], a: number, b: number): number =>
  starts.length === 0 ? 0 : Math.ceil(((b < starts.length ? starts[b]! : text.length) - starts[Math.min(a, starts.length) - 1]!) / 4)

interface BlockRow {
  owner_id: string
  block_id: string
  kind: string
  inner_path: string
  start_line: number
  end_line: number
}

const innermost = (blocks: readonly BlockRow[], line: number): BlockRow | undefined =>
  blocks.filter((b) => b.start_line <= line && line <= b.end_line).sort((a, b) => a.end_line - a.start_line - (b.end_line - b.start_line) || a.start_line - b.start_line)[0]

/**
 * Fills the location of `results` (in place): see the header. `vectorBlocks`: for a note hit, the `block_id` the
 * vector leg found nearest (by `note:<id>`).
 */
export async function locateHits(results: SearchResult[], query: string, vectorBlocks: ReadonlyMap<string, string>): Promise<void> {
  const terms = matchTerms(query)
  const noteIds = results.filter((r) => r.resourceType === 'note').map((r) => r.id)
  const fileIds = results.filter((r) => r.resourceType === 'code').map((r) => r.id)
  const symbolIds = results.filter((r) => r.resourceType === 'symbol').map((r) => r.id)
  const uuids = (ids: string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`

  const [notes, files, symbols, noteBlocks, fileBlocks] = await Promise.all([
    noteIds.length === 0
      ? []
      : (db.execute(sql`
          SELECT id, CASE WHEN length(body) <= ${LOCATE_MAX_CHARS} THEN body END AS body, frontmatter, frontmatter_src
          FROM notes WHERE id = ANY(${uuids(noteIds)})`) as unknown as Promise<Array<{ id: string; body: string | null; frontmatter: unknown; frontmatter_src: unknown }>>),
    fileIds.length === 0
      ? []
      : (db.execute(sql`
          SELECT id, CASE WHEN length(content) <= ${LOCATE_MAX_CHARS} THEN content END AS content
          FROM repository_files WHERE id = ANY(${uuids(fileIds)})`) as unknown as Promise<Array<{ id: string; content: string | null }>>),
    symbolIds.length === 0
      ? []
      : (db.execute(sql`
          SELECT b.id, b.block_id, b.inner_path, CASE WHEN length(f.content) <= ${LOCATE_MAX_CHARS} THEN f.content END AS content
          FROM blocks b JOIN repository_files f ON f.id = b.owner_id WHERE b.id = ANY(${uuids(symbolIds)})`) as unknown as Promise<
          Array<{ id: string; block_id: string; inner_path: string; content: string | null }>
        >),
    noteIds.length === 0
      ? []
      : (db.execute(sql`
          SELECT owner_id, block_id, kind, inner_path, start_line, end_line FROM blocks
          WHERE owner_type = 'note' AND owner_id = ANY(${uuids(noteIds)}) AND end_line >= start_line`) as unknown as Promise<BlockRow[]>),
    fileIds.length === 0
      ? []
      : (db.execute(sql`
          SELECT owner_id, block_id, kind, inner_path, start_line, end_line FROM blocks
          WHERE owner_type = 'code' AND kind = 'symbol' AND owner_id = ANY(${uuids(fileIds)})`) as unknown as Promise<BlockRow[]>),
  ])

  const noteById = new Map(notes.map((n) => [n.id, n]))
  const fileById = new Map(files.map((f) => [f.id, f]))
  const symbolById = new Map(symbols.map((s) => [s.id, s]))
  const blocksOf = (rows: readonly BlockRow[]) => {
    const byOwner = new Map<string, BlockRow[]>()
    for (const row of rows) byOwner.set(row.owner_id, [...(byOwner.get(row.owner_id) ?? []), row])
    return byOwner
  }
  const noteBlocksBy = blocksOf(noteBlocks)
  const fileBlocksBy = blocksOf(fileBlocks)

  for (const hit of results) {
    if (hit.resourceType === 'symbol') {
      const row = symbolById.get(hit.id)
      if (!row || hit.startLine === undefined || hit.endLine === undefined) continue
      hit.block = row.block_id
      hit.heading = row.inner_path
      if (row.content !== null) hit.tokens = spanTokens(row.content, lineStarts(row.content), hit.startLine, hit.endLine)
      continue
    }
    if (hit.resourceType === 'note') {
      const row = noteById.get(hit.id)
      const blocks = noteBlocksBy.get(hit.id) ?? []
      if (!row || row.body === null) continue
      const starts = lineStarts(row.body)
      const place = bestPlace(row.body, starts, terms)
      const wanted = vectorBlocks.get(`note:${hit.id}`)
      const block = blocks.find((b) => b.block_id === wanted) ?? (place ? innermost(blocks, place.line) : undefined) ?? blocks.sort((a, b) => a.start_line - b.start_line)[0]
      if (!block) continue
      const shift = bodyStartLine({ frontmatter: row.frontmatter, frontmatterSrc: row.frontmatter_src }) - 1
      hit.block = block.block_id
      if (block.kind === 'section') hit.heading = block.inner_path
      hit.startLine = block.start_line + shift
      hit.endLine = block.end_line + shift
      hit.tokens = spanTokens(row.body, starts, block.start_line, block.end_line)
      // The match inside the block the hit points at, else the start of the block.
      const inside = place && place.line >= block.start_line && place.line <= block.end_line ? place : null
      hit.snippet = snippetAround(row.body, inside ? inside.at : (starts[block.start_line - 1] ?? 0), terms)
      continue
    }
    const row = fileById.get(hit.id)
    if (!row || row.content === null) continue
    const starts = lineStarts(row.content)
    const place = bestPlace(row.content, starts, terms)
    if (!place) continue
    const block = innermost(fileBlocksBy.get(hit.id) ?? [], place.line)
    hit.startLine = block ? block.start_line : place.line
    hit.endLine = block ? block.end_line : place.line
    if (block) {
      hit.block = block.block_id
      hit.heading = block.inner_path
    }
    hit.tokens = spanTokens(row.content, starts, hit.startLine, hit.endLine)
    hit.snippet = snippetAround(row.content, place.at, terms)
  }
}
