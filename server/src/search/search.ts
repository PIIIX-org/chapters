import { sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { config } from '../config.js'
import { embedder } from './embeddings.js'
import { embeddingState } from './embedding-queue.js'
import { extractionState } from '../repositories/extraction-queue.js'
import { passesFilters, timeBound, type GraphFilters } from '../graph/assemble.js'
import { compareCodeUnits } from '../mcp/response.js'

function uuidArray(ids: string[]): SQL {
  // ponytail: single Postgres array parameter literal instead of N placeholders (DB-07).
  return sql`${`{${ids.join(',')}}`}::uuid[]`
}

/**
 * A `since`/`until` bound on `notes.updated_at` (#446): a bound that is no
 * date matches nothing, as in `passesFilters`. Both sides are compared at
 * millisecond precision (`timeBound` and graph nodes' `updatedAt` hold no
 * more), so search and graph agree on a change within a bound's millisecond.
 */
function updatedBound(op: SQL, value: string): SQL {
  const bound = timeBound(value)
  return bound === null ? sql`AND false` : sql`AND date_trunc('milliseconds', updated_at) ${op} ${bound}::timestamptz`
}

function noteFilterClauses(filters?: GraphFilters): SQL {
  const clauses: SQL[] = []
  if (filters?.types && filters.types.length > 0) {
    clauses.push(sql`AND type = ANY(${`{${filters.types.join(',')}}`}::text[])`)
  }
  if (filters?.since) clauses.push(updatedBound(sql`>=`, filters.since))
  if (filters?.until) clauses.push(updatedBound(sql`<=`, filters.until))
  return clauses.length > 0 ? sql.join(clauses, sql` `) : sql``
}

/** `updated_at` as `toISOString` text (what graph nodes and `passesFilters` compare). */
const UPDATED_AT = (column: SQL) => sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at`

export type ResourceType = 'note' | 'code' | 'symbol'

export interface SearchResourceSet {
  vaultIds: string[]
  repositoryIds: string[]
}

export interface SearchResult {
  resourceType: ResourceType
  id: string // noteId, repositoryFileId, or symbolId
  containerId: string // vaultId or repositoryId
  path: string
  type?: string | null // note OKF type, code language, or symbol kind
  frontmatter?: unknown // notes only
  language?: string | null // code only
  symbolName?: string // symbols only
  symbolKind?: string // symbols only
  symbolParent?: string // symbols only: a method's class (#450)
  startLine?: number // symbols only
  endLine?: number // symbols only
  snippet: string
  score: number
  /** The UTC day (`YYYY-MM-DD`) of the last change: the note's, the code file's (its last sync that changed it), a symbol's file's (#446). */
  updated: string
}

export interface SymbolSearchResult {
  id: string
  fileId: string
  repositoryId: string
  path: string
  name: string
  kind: string
  /** A method's class or a namespace member's namespace (#450); absent at module level. */
  parent?: string
  startLine: number
  endLine: number
  snippet: string | null
  score: number
}

export interface SearchNotesOptions {
  includeSymbols?: boolean
}

/**
 * The answer of every search (#441, #442, #458; ADR-004 §2.3), the same over
 * MCP and REST (MCP adds the budget's `truncated`):
 *
 * - `status`: `ok` when a result passed the relevance gate; with no result,
 *   `unavailable` when no retrieval channel could run or every item in scope
 *   failed indexing (a repository whose sync failed before any file landed
 *   counts as one failed item), `index_building` when notes, files or whole
 *   repositories in scope are still to be indexed, else `no_match`.
 * - `retrieval_mode`: the channels that answered: `hybrid` (keyword and
 *   vector), `keyword_only`, `vector_only`, or `none` (no channel answered:
 *   `unavailable`, or `no_match` for an empty query or scope).
 * - `degraded`: false, or why a channel is missing: the query embedding
 *   failed (`embedder_failed`), a vector query failed (`vector_leg_failed`)
 *   or a keyword query failed (`keyword_leg_failed`).
 * - `index`: the scope's notes and files still to be indexed, its
 *   repositories whose first sync is running or has not happened (no file
 *   yet), and the items whose indexing failed; left out when all are 0.
 * - `results`: in one total order, score descending, then path and id by
 *   UTF-16 code unit (`COLLATE "C"` in SQL).
 */
export type SearchStatus = 'ok' | 'no_match' | 'index_building' | 'unavailable'
export type RetrievalMode = 'hybrid' | 'keyword_only' | 'vector_only' | 'none'
export type Degraded = false | { reason: 'embedder_failed' | 'vector_leg_failed' | 'keyword_leg_failed' }
export interface IndexState {
  pending_notes: number
  pending_files: number
  pending_repositories: number
  failed: number
}
export interface SearchResponse<H> {
  status: SearchStatus
  retrieval_mode: RetrievalMode
  degraded: Degraded
  index?: IndexState
  results: H[]
}

const CANDIDATES = 30
const RRF_K = 60

interface Row {
  id: string
  container_id: string
  path: string
  type?: string | null
  frontmatter?: unknown
  language?: string | null
  snippet: string
  updated_at: string
}

interface SymbolRow {
  id: string
  file_id: string
  container_id: string
  path: string
  name: string
  kind: string
  parent: string | null
  start_line: number
  end_line: number
  snippet: string
  updated_at: string
}

/**
 * The `CANDIDATES` nearest rows of `nearest` (a query ordered by `distance`
 * alone, so the HNSW index serves it), cut at the relevance gate (#441) and
 * re-sorted with the total order's tie-break.
 */
function gated(nearest: SQL): SQL {
  return sql`
    SELECT * FROM (${nearest} LIMIT ${CANDIDATES}) nearest
    WHERE distance < ${config.searchMaxDistance}
    ORDER BY distance, path COLLATE "C", id`
}

async function noteRows(
  vaultIds: string[],
  query: string,
  mode: 'keyword' | 'semantic',
  vec?: string,
  filters?: GraphFilters,
): Promise<Row[]> {
  if (vaultIds.length === 0) return []
  const filterSql = noteFilterClauses(filters)
  // ponytail: CTE wraps candidate search so ts_headline only runs on top 30 rows instead of whole table (DB-12, DB-14).
  const rows =
    mode === 'keyword'
      ? await db.execute(sql`
          WITH top_notes AS (
            SELECT id, vault_id AS container_id, path, type, frontmatter, body, ${UPDATED_AT(sql`updated_at`)},
                   ts_rank(fts, websearch_to_tsquery('english', ${query})) AS rank
            FROM notes
            WHERE vault_id = ANY(${uuidArray(vaultIds)})
              AND deleted_at IS NULL
              AND fts @@ websearch_to_tsquery('english', ${query})
              ${filterSql}
            ORDER BY rank DESC, path COLLATE "C", id
            LIMIT ${CANDIDATES}
          )
          SELECT id, container_id, path, type, frontmatter, updated_at,
                 ts_headline('english', body, websearch_to_tsquery('english', ${query}),
                             'MaxWords=30, MinWords=10') AS snippet
          FROM top_notes
          ORDER BY rank DESC, path COLLATE "C", id
        `)
      : await db.execute(
          gated(sql`
            SELECT id, vault_id AS container_id, path, type, frontmatter, left(body, 200) AS snippet, ${UPDATED_AT(sql`updated_at`)},
                   embedding <=> ${vec}::vector AS distance
            FROM notes
            WHERE vault_id = ANY(${uuidArray(vaultIds)})
              AND deleted_at IS NULL
              AND embedding IS NOT NULL
              ${filterSql}
            ORDER BY embedding <=> ${vec}::vector`),
        )
  return rows as unknown as Row[]
}

async function codeRows(repositoryIds: string[], query: string, mode: 'keyword' | 'semantic', vec?: string): Promise<Row[]> {
  if (repositoryIds.length === 0) return []
  // ponytail: CTE wraps candidate search so ts_headline only runs on top 30 files (DB-12).
  const rows =
    mode === 'keyword'
      ? await db.execute(sql`
          WITH top_code AS (
            SELECT id, repository_id AS container_id, path, language, content, ${UPDATED_AT(sql`updated_at`)},
                   ts_rank(fts, websearch_to_tsquery('english', ${query})) AS rank
            FROM repository_files
            WHERE repository_id = ANY(${uuidArray(repositoryIds)})
              AND fts @@ websearch_to_tsquery('english', ${query})
            ORDER BY rank DESC, path COLLATE "C", id
            LIMIT ${CANDIDATES}
          )
          SELECT id, container_id, path, language, updated_at,
                 ts_headline('english', content, websearch_to_tsquery('english', ${query}),
                             'MaxWords=30, MinWords=10') AS snippet
          FROM top_code
          ORDER BY rank DESC, path COLLATE "C", id
        `)
      : await db.execute(
          gated(sql`
            SELECT id, repository_id AS container_id, path, language, left(content, 200) AS snippet, ${UPDATED_AT(sql`updated_at`)},
                   embedding <=> ${vec}::vector AS distance
            FROM repository_files
            WHERE repository_id = ANY(${uuidArray(repositoryIds)})
              AND embedding IS NOT NULL
            ORDER BY embedding <=> ${vec}::vector`),
        )
  return rows as unknown as Row[]
}

async function symbolRows(
  repositoryIds: string[],
  query: string,
  mode: 'keyword' | 'semantic',
  vec?: string,
  kindFilter?: string,
): Promise<SymbolRow[]> {
  if (repositoryIds.length === 0) return []
  const rows =
    mode === 'keyword'
      ? await db.execute(sql`
          SELECT s.id, s.file_id, f.repository_id AS container_id, f.path,
                 s.name, s.kind, s.parent, s.start_line, s.end_line,
                 coalesce(s.snippet, s.name) AS snippet, ${UPDATED_AT(sql`f.updated_at`)}
          FROM repository_file_symbols s
          JOIN repository_files f ON f.id = s.file_id
          WHERE f.repository_id = ANY(${uuidArray(repositoryIds)})
            ${kindFilter ? sql`AND s.kind = ${kindFilter}` : sql``}
            AND (
              s.name ILIKE ${`%${query}%`}
              OR (s.snippet IS NOT NULL AND s.snippet ILIKE ${`%${query}%`})
              OR s.parent || '.' || s.name ILIKE ${`%${query}%`}
            )
          ORDER BY
            CASE
              WHEN lower(s.name) = lower(${query}) OR lower(s.parent || '.' || s.name) = lower(${query}) THEN 1
              WHEN lower(s.name) LIKE lower(${`${query}%`}) THEN 2
              ELSE 3
            END,
            f.path COLLATE "C", s.id
          LIMIT ${CANDIDATES}
        `)
      : await db.execute(
          gated(sql`
            SELECT s.id, s.file_id, f.repository_id AS container_id, f.path,
                   s.name, s.kind, s.parent, s.start_line, s.end_line,
                   coalesce(s.snippet, s.name) AS snippet, ${UPDATED_AT(sql`f.updated_at`)},
                   s.embedding <=> ${vec}::vector AS distance
            FROM repository_file_symbols s
            JOIN repository_files f ON f.id = s.file_id
            WHERE f.repository_id = ANY(${uuidArray(repositoryIds)})
              ${kindFilter ? sql`AND s.kind = ${kindFilter}` : sql``}
              AND s.embedding IS NOT NULL
            ORDER BY s.embedding <=> ${vec}::vector`),
        )
  return rows as unknown as SymbolRow[]
}

/** The query's vector as a pgvector literal, or null when the embedder failed: search then answers from the keyword channel (#458). */
async function queryVector(query: string): Promise<string | null> {
  try {
    const [vector] = await embedder.embed([query])
    return JSON.stringify(vector)
  } catch (err) {
    console.warn('[search] query embedding failed; answering from the keyword channel:', err)
    return null
  }
}

/** One channel's legs, or null when one of them failed (the channel then answers nothing). */
async function channel<T extends readonly unknown[]>(name: string, legs: { [K in keyof T]: Promise<T[K]> }): Promise<T | null> {
  try {
    return (await Promise.all(legs)) as unknown as T
  } catch (err) {
    console.warn(`[search] the ${name} channel failed:`, err)
    return null
  }
}

/** The items of the scope still to be indexed or whose indexing failed, and how many items it has. */
async function indexState(vaultIds: string[], repositoryIds: string[]): Promise<{ index: IndexState; items: number } | null> {
  try {
    const [notes, files] = await Promise.all([embeddingState(vaultIds), extractionState(repositoryIds)])
    return {
      index: {
        pending_notes: notes.pending,
        pending_files: files.pending,
        pending_repositories: files.syncing,
        failed: notes.failed + files.failed + files.syncFailed,
      },
      items: notes.notes + files.files + files.syncFailed,
    }
  } catch (err) {
    console.warn('[search] the index state could not be read:', err)
    return null
  }
}

/** The envelope around `results`, from which channels answered and the scope's index state. */
function respond<H>(
  results: H[],
  vectorTried: boolean,
  keyword: unknown,
  vector: unknown,
  state: { index: IndexState; items: number } | null,
): SearchResponse<H> {
  const keywordRan = keyword !== null
  const vectorRan = vector !== null
  const retrieval_mode: RetrievalMode = keywordRan && vectorRan ? 'hybrid' : vectorRan ? 'vector_only' : keywordRan ? 'keyword_only' : 'none'
  const degraded: Degraded = !vectorTried
    ? { reason: 'embedder_failed' }
    : !vectorRan
      ? { reason: 'vector_leg_failed' }
      : !keywordRan
        ? { reason: 'keyword_leg_failed' }
        : false
  const index = state?.index
  const pending = index ? index.pending_notes + index.pending_files + index.pending_repositories : 0
  const status: SearchStatus =
    results.length > 0
      ? 'ok'
      : !keywordRan && !vectorRan
        ? 'unavailable'
        : pending > 0
          ? 'index_building'
          : index && index.failed > 0 && index.failed === state?.items
            ? 'unavailable'
            : 'no_match'
  const shown = index && (pending > 0 || index.failed > 0) ? { index } : {}
  return { status, retrieval_mode, degraded, ...shown, results }
}

/** The total order of every answer: score descending, then path, then id, by code unit. */
function byScore(a: { score: number; path: string; id: string }, b: { score: number; path: string; id: string }): number {
  return b.score - a.score || compareCodeUnits(a.path, b.path) || compareCodeUnits(a.id, b.id)
}

/** The answer to an empty query or an empty scope: nothing was searched. */
const NOTHING: SearchResponse<never> = { status: 'no_match', retrieval_mode: 'none', degraded: false, results: [] }

/**
 * Fine-grained AST symbol retrieval via vector embeddings + keyword ranking.
 * Fulfills Issue #262: lets MCP agents locate exact functions/classes/types
 * without burning tokens downloading full source files.
 */
export async function findSymbols(
  repositoryIds: string[],
  query: string,
  options?: {
    kind?: string
    limit?: number
  },
): Promise<SearchResponse<SymbolSearchResult>> {
  if (repositoryIds.length === 0 || query.trim() === '') return { ...NOTHING, results: [] }
  const limit = options?.limit ?? 20
  const kind = options?.kind

  const state = indexState([], repositoryIds)
  const vec = await queryVector(query)
  const [keyword, vector] = await Promise.all([
    channel<[SymbolRow[]]>('keyword', [symbolRows(repositoryIds, query, 'keyword', undefined, kind)]),
    vec === null ? null : channel<[SymbolRow[]]>('vector', [symbolRows(repositoryIds, query, 'semantic', vec, kind)]),
  ])

  const map = new Map<string, SymbolSearchResult>()
  const contribute = (rows: SymbolRow[], preferSnippet: boolean) => {
    rows.forEach((row, rank) => {
      const contribution = 1 / (RRF_K + rank + 1)
      const existing = map.get(row.id)
      if (existing) {
        existing.score += contribution
        if (preferSnippet && row.snippet) existing.snippet = row.snippet
      } else {
        map.set(row.id, {
          id: row.id,
          fileId: row.file_id,
          repositoryId: row.container_id,
          path: row.path,
          name: row.name,
          kind: row.kind,
          ...(row.parent !== null ? { parent: row.parent } : {}),
          startLine: row.start_line,
          endLine: row.end_line,
          snippet: row.snippet || null,
          score: contribution,
        })
      }
    })
  }

  if (vector) contribute(vector[0], false)
  if (keyword) contribute(keyword[0], true)

  const results = [...map.values()].sort(byScore).slice(0, limit)
  return respond(results, vec !== null, keyword, vector, await state)
}

/**
 * The one search function every caller uses (spec 4/9: human UI and MCP
 * share one path across both notes and code — results never diverge).
 * Hybrid retrieval: Postgres FTS + embedding KNN cut at the relevance gate,
 * merged by Reciprocal Rank Fusion.
 */
export async function searchNotes(
  resources: SearchResourceSet,
  query: string,
  limit = 20,
  filters: GraphFilters = {},
  options: SearchNotesOptions = {},
): Promise<SearchResponse<SearchResult>> {
  const { vaultIds, repositoryIds } = resources
  if ((vaultIds.length === 0 && repositoryIds.length === 0) || query.trim() === '') return { ...NOTHING, results: [] }

  const includeSymbols = options.includeSymbols ?? false
  const symbolRepos = includeSymbols ? repositoryIds : []
  const state = indexState(vaultIds, repositoryIds)
  const vec = await queryVector(query)
  const [keyword, vector] = await Promise.all([
    channel<[Row[], Row[], SymbolRow[]]>('keyword', [
      noteRows(vaultIds, query, 'keyword', undefined, filters),
      codeRows(repositoryIds, query, 'keyword'),
      symbolRows(symbolRepos, query, 'keyword'),
    ]),
    vec === null
      ? null
      : channel<[Row[], Row[], SymbolRow[]]>('vector', [
          noteRows(vaultIds, query, 'semantic', vec, filters),
          codeRows(repositoryIds, query, 'semantic', vec),
          symbolRows(symbolRepos, query, 'semantic', vec),
        ]),
  ])

  // Reciprocal Rank Fusion — rank-based, no score normalization to tune.
  const merged = new Map<string, SearchResult>()
  // Each hit's full `updated_at`, for `since`/`until`; the hit itself shows the day only.
  const lastChange = new Map<string, string>()
  const contribute = (resourceType: ResourceType, rows: Row[], preferSnippet: boolean): void => {
    rows.forEach((row, rank) => {
      const key = `${resourceType}:${row.id}`
      const contribution = 1 / (RRF_K + rank + 1)
      const existing = merged.get(key)
      if (existing) {
        existing.score += contribution
        if (preferSnippet) existing.snippet = row.snippet
      } else {
        lastChange.set(key, row.updated_at)
        merged.set(key, {
          resourceType,
          id: row.id,
          containerId: row.container_id,
          path: row.path,
          type: resourceType === 'note' ? (row.type ?? null) : (row.language ?? null),
          frontmatter: resourceType === 'note' ? row.frontmatter : undefined,
          language: resourceType === 'code' ? row.language : undefined,
          updated: row.updated_at.slice(0, 10),
          snippet: row.snippet,
          score: contribution,
        })
      }
    })
  }

  const contributeSymbols = (rows: SymbolRow[], preferSnippet: boolean): void => {
    rows.forEach((row, rank) => {
      const key = `symbol:${row.id}`
      const contribution = 1 / (RRF_K + rank + 1)
      const existing = merged.get(key)
      if (existing) {
        existing.score += contribution
        if (preferSnippet && row.snippet) existing.snippet = row.snippet
      } else {
        lastChange.set(key, row.updated_at)
        merged.set(key, {
          resourceType: 'symbol',
          id: row.id,
          containerId: row.container_id,
          path: row.path,
          type: row.kind,
          symbolName: row.name,
          symbolKind: row.kind,
          ...(row.parent !== null ? { symbolParent: row.parent } : {}),
          startLine: row.start_line,
          endLine: row.end_line,
          updated: row.updated_at.slice(0, 10),
          snippet: row.snippet,
          score: contribution,
        })
      }
    })
  }

  if (vector) {
    contribute('note', vector[0], false)
    contribute('code', vector[1], false)
  }
  if (keyword) {
    contribute('note', keyword[0], true)
    contribute('code', keyword[1], true)
  }
  if (vector) contributeSymbols(vector[2], false)
  if (keyword) contributeSymbols(keyword[2], true)

  const filtered = [...merged].filter(([key, r]) => {
    const fm = (r.frontmatter ?? {}) as { tags?: unknown }
    return passesFilters({ type: r.type ?? null, tags: Array.isArray(fm.tags) ? (fm.tags as string[]) : [], updatedAt: lastChange.get(key)! }, filters)
  }).map(([, r]) => r)

  return respond(filtered.sort(byScore).slice(0, limit), vec !== null, keyword, vector, await state)
}
