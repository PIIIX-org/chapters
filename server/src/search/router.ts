// The query router (#1060): a question with one exact answer in the index is answered by exact lookup, not by a
// ranked list of look-alikes. No model: the route is decided from the shape of the query, and the answer is read
// from the symbol blocks and the paths. A query that is not one of these (or whose lookup finds nothing) is
// `conceptual` and takes the hybrid path unchanged; its response does not name a route.
//
//   identifier  one identifier asked for ("parseNote", "where is `Store.save` defined"): the symbols of that name,
//               by any spelling `identifiers.ts` knows; one is the answer (`confidence` 1), several are all
//               listed, labelled by file and kind (`ambiguous`), and nothing fuzzy is added.
//   path        a file path or file name, or a note path: that file or note.
//
// Only queries of at most `MAX_WORDS` words are routed, and only without filters (they would narrow a lookup that
// has no list to narrow).
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { splitIdentifier } from './identifiers.js'
import { locateHits } from './locate.js'
import type { SearchResult } from './search.js'

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
  route: 'identifier' | 'path'
  results: SearchResult[]
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

/** The routed answer of `query` in these resources, or null when it is a conceptual query or nothing answers it exactly. */
export async function routeQuery(resources: { vaultIds: string[]; repositoryIds: string[] }, query: string, includeSymbols: boolean): Promise<Routed | null> {
  const term = routeTerm(query)
  if (term === null) return null
  const lower = term.toLowerCase()

  // A path: a file by its path or its file name, a note by its path (with or without `.md`).
  if (term.includes('/') || /[\p{L}\p{N}]\.[A-Za-z0-9]{1,8}$/u.test(term)) {
    const files =
      resources.repositoryIds.length === 0
        ? []
        : ((await db.execute(sql`
            SELECT f.id, f.repository_id AS container_id, f.path, f.language, left(f.content, 200) AS head, length(f.content) AS chars,
                   greatest(length(f.content) - length(replace(f.content, E'\n', '')) + (CASE WHEN right(f.content, 1) = E'\n' THEN 0 ELSE 1 END), 1) AS lines, to_char(f.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS updated
            FROM repository_files f
            WHERE f.repository_id = ANY(${uuids(resources.repositoryIds)}) AND (lower(f.path) = ${lower} OR lower(f.path) LIKE ${`%/${lower.replace(/[\\%_]/g, '\\$&')}`})
            ORDER BY f.path COLLATE "C", f.id LIMIT ${MAX_ROUTED + 1}`)) as unknown as Array<{ id: string; container_id: string; path: string; language: string | null; head: string; chars: number; lines: number; updated: string }>)
    const notes =
      resources.vaultIds.length === 0
        ? []
        : ((await db.execute(sql`
            SELECT n.id, n.vault_id AS container_id, n.path, n.type, left(n.body, 200) AS head, length(n.body) AS chars, to_char(n.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS updated
            FROM notes n
            WHERE n.vault_id = ANY(${uuids(resources.vaultIds)}) AND n.deleted_at IS NULL AND (lower(n.path) = ${lower} OR lower(n.path) || '.md' = ${lower})
            ORDER BY n.path COLLATE "C", n.id LIMIT ${MAX_ROUTED + 1}`)) as unknown as Array<{ id: string; container_id: string; path: string; type: string; head: string; chars: number; updated: string }>)
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
    if (results.length > 0) return { route: 'path', results, ...(results.length === 1 ? { confidence: 1 as const } : { ambiguous: true as const }) }
  }

  if (!includeSymbols || resources.repositoryIds.length === 0) return null
  // An identifier: the symbols named so, in any spelling, or by their `Class.name`.
  const id = splitIdentifier(term)
  const spellings = [...new Set([lower, id.whole, id.parts.join(''), id.parts.join('_'), id.parts.join('-')].filter((s) => s.length > 0))]
  const symbols = (await db.execute(sql`
    SELECT b.id, b.block_id, b.container_id, f.path, b.symbol_kind AS kind, b.symbol_parent AS parent, b.inner_path, b.start_line, b.end_line,
           coalesce(b.snippet, b.inner_path) AS snippet, to_char(f.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS updated,
           CASE WHEN b.symbol_parent IS NULL THEN b.inner_path ELSE substr(b.inner_path, length(b.symbol_parent) + 2) END AS name
    FROM blocks b JOIN repository_files f ON f.id = b.owner_id
    WHERE b.owner_type = 'code' AND b.kind = 'symbol' AND b.container_id = ANY(${uuids(resources.repositoryIds)})
      AND (lower(CASE WHEN b.symbol_parent IS NULL THEN b.inner_path ELSE substr(b.inner_path, length(b.symbol_parent) + 2) END) = ANY(${texts(spellings)})
        OR lower(b.inner_path) = ANY(${texts(spellings)}))
    ORDER BY f.path COLLATE "C", b.start_line, b.id LIMIT ${MAX_ROUTED + 1}`)) as unknown as Array<{
    id: string; block_id: string; container_id: string; path: string; kind: string; parent: string | null; inner_path: string
    start_line: number; end_line: number; snippet: string; updated: string; name: string
  }>
  if (symbols.length === 0 || symbols.length > MAX_ROUTED) return null
  const results = symbols.map((s): SearchResult => ({
    resourceType: 'symbol', id: s.id, containerId: s.container_id, path: s.path, type: s.kind, symbolName: s.name, symbolKind: s.kind,
    ...(s.parent !== null ? { symbolParent: s.parent } : {}), startLine: s.start_line, endLine: s.end_line, updated: s.updated,
    channel: 'exact', snippet: s.snippet, score: 1,
  }))
  await locateHits(results, query, new Map())
  return { route: 'identifier', results, ...(results.length === 1 ? { confidence: 1 as const } : { ambiguous: true as const }) }
}
