// Deterministic lookup before hybrid retrieval (#1060). Misses retain their attempted route.
import { sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { locateHits } from './locate.js'
import { splitIdentifier } from './identifiers.js'
import { fileFilter, noteFilter, symbolFilter, type SearchFilters, type SearchResult, type SearchOutlineEntry } from './search.js'
import { codeSites } from '../repositories/code-queries.js'
import { classifyStructural, dispatchStructural, type StructuralSite, type StructuralQuestion, type StructuralTarget } from './structural.js'
import { bodyStartLine } from '../notes/projector.js'

export const SEARCH_ROUTES = ['identifier', 'path', 'structural', 'conceptual'] as const
export type SearchRoute = typeof SEARCH_ROUTES[number]

/** Words of a query that may surround the identifier it asks for. */
const MAX_WORDS = 6
/** The most hits of a route: more than this is not an answer. */
const MAX_ROUTED = 10
/** Words that ask for a definition without naming anything. */
const FILLER = new Set(
  "where is are the a an defined definition declared implemented implementation of find show me locate function class method interface type symbol what does in code for where's file".split(' '),
)
const TERM = /^[\p{L}\p{N}_$.:/-]{3,200}$/u
const EDGES = /^[^\p{L}\p{N}_$/.:-]+|[^\p{L}\p{N}_$/]+$/gu

export interface Routed {
  route: SearchRoute
  results: SearchResult[]
  textual?: StructuralSite[]
  partial?: true
  /** 1: one exact answer. */
  confidence?: 1
  /** Several exact answers, all listed. */
  ambiguous?: true
}

/** The one term a query asks for, or null: backticked, or the only word left once the filler words are dropped. */
export function routeTerm(query: string): string | null {
  const words = query.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0 || words.length > MAX_WORDS) return null
  // The words that are not filler; a backticked token is the term when nothing else is left (`who calls \`X\`` asks for callers, not for X).
  const left = words.filter((w) => !FILLER.has(w.toLowerCase().replace(/[?!.,;:`]+$/, '')))
  if (left.length !== 1) return null
  const term = left[0]!.replace(/^`([^`]+)`$/, '$1').replace(EDGES, '').replace(/^\.?\//, '')
  return TERM.test(term) ? term : null
}

const uuids = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`
const texts = (values: readonly string[]) => sql`${`{${values.map((v) => JSON.stringify(v)).join(',')}}`}::text[]`

export function classifyQuery(query: string): SearchRoute {
  if (classifyStructural(query)) return 'structural'
  const term = routeTerm(query)
  return term === null ? 'conceptual' : term.includes('/') || /[\p{L}\p{N}]\.[A-Za-z0-9]{1,8}$/u.test(term) ? 'path' : 'identifier'
}

/** Filters apply before bounded lookup, not after slicing away potential answers. */
export async function routeQuery(
  resources: { vaultIds: string[]; repositoryIds: string[] }, query: string, includeSymbols: boolean,
  route: SearchRoute = classifyQuery(query), filters: SearchFilters = {}, automatic = true,
): Promise<Routed | null> {
  if (route === 'conceptual') return null
  const question = route === 'structural' ? classifyStructural(query) : null
  const term = question?.term ?? routeTerm(query)
  if (term === null || (route === 'structural' && question === null)) return null
  const lower = term.toLowerCase()
  const [fileClauses, noteClauses, symbolClauses] = [fileFilter(filters), noteFilter(filters), symbolFilter(filters)]
  const clauses = (value: SQL[] | null) => value === null ? sql`AND false` : sql.join(value, sql` `)

  if (route === 'path' || question?.kind === 'imports') {
    const files =
      resources.repositoryIds.length === 0
        ? []
        : ((await db.execute(sql`
            SELECT f.id, f.repository_id AS container_id, f.path, f.language, left(f.content, 200) AS head, length(f.content) AS chars,
                   greatest(length(f.content) - length(replace(f.content, E'\n', '')) + (CASE WHEN right(f.content, 1) = E'\n' THEN 0 ELSE 1 END), 1) AS lines, to_char(f.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS updated
            FROM repository_files f
            WHERE f.repository_id = ANY(${uuids(resources.repositoryIds)}) AND (lower(f.path) = ${lower} OR lower(f.path) LIKE ${`%/${lower.replace(/[\\%_]/g, '\\$&')}`})
              ${clauses(fileClauses)}
            ORDER BY f.path COLLATE "C", f.id LIMIT ${MAX_ROUTED + 1}`)) as unknown as Array<{ id: string; container_id: string; path: string; language: string | null; head: string; chars: number; lines: number; updated: string }>)
    const notes =
      resources.vaultIds.length === 0 || question !== null
        ? []
        : ((await db.execute(sql`
            SELECT notes.id, notes.vault_id AS container_id, notes.path, notes.type, left(notes.body, 200) AS head, length(notes.body) AS chars, to_char(notes.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS updated
            FROM notes
            WHERE notes.vault_id = ANY(${uuids(resources.vaultIds)}) AND notes.deleted_at IS NULL AND (lower(notes.path) = ${lower} OR lower(notes.path) || '.md' = ${lower})
              ${clauses(noteClauses)}
            ORDER BY notes.path COLLATE "C", notes.id LIMIT ${MAX_ROUTED + 1}`)) as unknown as Array<{ id: string; container_id: string; path: string; type: string; head: string; chars: number; updated: string }>)
    const results: SearchResult[] = [
      ...files.map((f): SearchResult => ({
        resourceType: 'code', id: f.id, containerId: f.container_id, path: f.path, type: f.language, language: f.language, updated: f.updated,
        startLine: 1, endLine: f.lines, tokens: Math.ceil(f.chars / 4), channel: 'exact', snippet: f.head, score: 1,
      })),
      ...notes.map((n): SearchResult => ({
        resourceType: 'note', id: n.id, containerId: n.container_id, path: n.path, type: n.type, updated: n.updated,
        tokens: Math.ceil(n.chars / 4), channel: 'exact', snippet: n.head, score: 1,
      })),
    ]
    // More than `MAX_ROUTED` exact answers is not an answer: the hybrid path ranks them.
    if (results.length > MAX_ROUTED) return null
    if (question?.kind === 'imports' && files.length === 1) {
      const f = files[0]!
      return structuralAnswer(question, [{ repositoryId: f.container_id, target: { fileId: f.id, blockIds: [], name: term, symbol: term, wholeFile: true } }], filters)
    }
    if (results.length > 0) {
      // A bounded outline for each direct file; the sentinel is explicitly reported.
      const ids = files.map((f) => f.id)
      if (ids.length > 0) {
        const outlines = await db.execute(sql`
          SELECT f.id, coalesce((SELECT jsonb_agg(o) FROM (
            SELECT b.inner_path AS name, b.symbol_kind AS kind, b.start_line AS "startLine", b.end_line AS "endLine"
            FROM blocks b WHERE b.owner_type = 'code' AND b.owner_id = f.id AND b.kind = 'symbol'
            ORDER BY b.start_line, b.id LIMIT 101) o), '[]'::jsonb) AS symbols
          FROM repository_files f WHERE f.id = ANY(${uuids(ids)})`) as unknown as Array<{ id: string; symbols: SearchOutlineEntry[] }>
        for (const f of outlines) {
          const hit = results.find((r) => r.resourceType === 'code' && r.id === f.id)!
          hit.outline = { symbols: f.symbols.slice(0, 100), truncated: f.symbols.length > 100 }
        }
      }
      const noteIds = notes.map((n) => n.id)
      if (noteIds.length > 0) {
        const outlines = await db.execute(sql`
          SELECT n.id, n.frontmatter, coalesce((SELECT jsonb_agg(o) FROM (
            SELECT b.inner_path AS name, b.kind, b.start_line AS "startLine", b.end_line AS "endLine"
            FROM blocks b WHERE b.owner_type = 'note' AND b.owner_id = n.id AND b.kind = 'section'
            ORDER BY b.start_line, b.id LIMIT 101) o), '[]'::jsonb) AS headings
          FROM notes n WHERE n.id = ANY(${uuids(noteIds)})`) as unknown as Array<{ id: string; frontmatter: unknown; headings: SearchOutlineEntry[] }>
        for (const n of outlines) {
          const hit = results.find((r) => r.resourceType === 'note' && r.id === n.id)!
          const shift = bodyStartLine({ frontmatter: n.frontmatter, frontmatterSrc: null }) - 1
          hit.outline = { headings: n.headings.slice(0, 100).map((h) => ({ ...h, startLine: h.startLine + shift, endLine: h.endLine + shift })), truncated: n.headings.length > 100 }
        }
      }
      return { route, results, ...(results.length === 1 ? { confidence: 1 as const } : { ambiguous: true as const }) }
    }
    if (route === 'path') {
      // Dotted symbols and file extensions share a shape. Auto tries the indexed path first;
      // an explicit path override never silently turns into a symbol lookup.
      if (!automatic || term.includes('/')) return null
      route = 'identifier'
    }
  }

  if ((!includeSymbols && route !== 'structural') || resources.repositoryIds.length === 0) return null
  // An identifier: the symbols named so, in any spelling, or by their `Class.name`.
  const id = splitIdentifier(term)
  const spellings = [...new Set([lower, id.whole, id.parts.join(''), id.parts.join('_'), id.parts.join('-')].filter((s) => s.length > 0))]
  const symbols = (await db.execute(sql`
    SELECT b.id, b.owner_id AS file_id, b.block_id, b.container_id, f.path, b.symbol_kind AS kind, b.symbol_parent AS parent, b.inner_path, b.start_line, b.end_line,
           coalesce(b.snippet, b.inner_path) AS snippet, to_char(f.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS updated,
           CASE WHEN b.symbol_parent IS NULL THEN b.inner_path ELSE substr(b.inner_path, length(b.symbol_parent) + 2) END AS name
    FROM blocks b JOIN repository_files f ON f.id = b.owner_id
    WHERE b.owner_type = 'code' AND b.kind = 'symbol' AND b.container_id = ANY(${uuids(resources.repositoryIds)})
      AND (lower(CASE WHEN b.symbol_parent IS NULL THEN b.inner_path ELSE substr(b.inner_path, length(b.symbol_parent) + 2) END) = ANY(${texts(spellings)})
        OR lower(b.inner_path) = ANY(${texts(spellings)}))
      ${clauses(symbolClauses)}
    ORDER BY f.path COLLATE "C", b.start_line, b.id LIMIT ${MAX_ROUTED + 1}`)) as unknown as Array<{
    id: string; file_id: string; block_id: string; container_id: string; path: string; kind: string; parent: string | null; inner_path: string
    start_line: number; end_line: number; snippet: string; updated: string; name: string
  }>
  if (symbols.length === 0 || symbols.length > MAX_ROUTED) return null
  if (question !== null && question.kind !== 'definition' && symbols.length === 1) {
    const s = symbols[0]!
    return structuralAnswer(question, [{ repositoryId: s.container_id, target: { fileId: s.file_id, blockIds: [s.block_id], name: s.name, symbol: s.inner_path } }], filters)
  }
  const results = symbols.map((s): SearchResult => ({
    resourceType: 'symbol', id: s.id, containerId: s.container_id, path: s.path, type: s.kind, symbolName: s.name, symbolKind: s.kind,
    ...(s.parent !== null ? { symbolParent: s.parent } : {}), startLine: s.start_line, endLine: s.end_line, updated: s.updated,
    channel: 'exact', snippet: s.snippet, score: 1,
  }))
  await locateHits(results, query, new Map())
  return { route, results, ...(results.length === 1 ? { confidence: 1 as const } : { ambiguous: true as const }) }
}

async function structuralAnswer(
  question: StructuralQuestion,
  targets: readonly StructuralTarget[], filters: SearchFilters,
): Promise<Routed> {
  const sites = await dispatchStructural(question, targets, MAX_ROUTED, { codeSites })
  const sourceFilters = fileFilter({ ...filters, kinds: undefined, types: undefined })
  const results: SearchResult[] = []
  const textual: StructuralSite[] = []
  // Hydrate all bounded source locations together; source filters cannot leak out-of-scope paths.
  const all = [...sites.resolved, ...sites.textual]
  if (all.length > 0 && sourceFilters !== null) {
    const matches = sql.join(all.map((s) => sql`(f.repository_id = ${s.repositoryId} AND f.path = ${s.path})`), sql` OR `)
    const files = await db.execute(sql`
      SELECT f.id, f.repository_id, f.path, f.language, to_char(f.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS updated
      FROM repository_files f WHERE (${matches}) ${sql.join(sourceFilters, sql` `)}`) as unknown as Array<{ id: string; repository_id: string; path: string; language: string; updated: string }>
    for (const site of all) {
      const f = files.find((f) => f.repository_id === site.repositoryId && f.path === site.path)
      if (!f) continue
      if (site.confidence === 'textual') textual.push(site)
      else results.push({ resourceType: 'code', id: f.id, containerId: f.repository_id, path: f.path, language: f.language, type: f.language, updated: f.updated,
        ...(site.line !== null ? { startLine: site.line, endLine: site.line } : {}), snippet: site.context, channel: 'exact', score: 1, edge: { kind: site.kind, confidence: 'resolved', symbol: site.symbol, col: site.col } })
    }
  }
  return { route: 'structural', results, textual, ...(sites.partial ? { partial: true } : {}) }
}
