import { sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { config } from '../config.js'
import { embedder } from './embeddings.js'
import { embeddingState } from './embedding-queue.js'
import { setHnswScan } from './hnsw.js'
import { extractionState } from '../repositories/extraction-queue.js'
import { timeBound, type GraphFilters } from '../graph/assemble.js'
import { compareCodeUnits } from '../mcp/response.js'

function uuidArray(ids: string[]): SQL {
  // ponytail: single Postgres array parameter literal instead of N placeholders (DB-07).
  return sql`${`{${ids.join(',')}}`}::uuid[]`
}

/** `values` as one Postgres `text[]` parameter, each element quoted (a comma, brace or quote in a value stays in it). */
function textArray(values: string[]): SQL {
  return sql`${`{${values.map((v) => `"${v.replace(/["\\]/g, '\\$&')}"`).join(',')}}`}::text[]`
}

/**
 * What a search keeps (#454). Every filter applies inside each leg's SQL,
 * before the leg's cut, so a filtered search answers with the best matching
 * rows, not the matching remains of the unfiltered best. A hit without the
 * filtered attribute is dropped: code has no tags, notes no language, files no
 * kind. `types` matches what a hit's `type` shows: a note's type, a file's
 * language, a symbol's kind. An empty list filters nothing.
 */
export interface SearchFilters extends Pick<GraphFilters, 'types' | 'tags' | 'since' | 'until'> {
  /** A code file's language, or a symbol's file's (repositories/language.ts). */
  languages?: string[]
  /** A symbol's kind (extraction.ts `SYMBOL_KINDS`). */
  kinds?: string[]
  /** A path prefix, or a glob when it holds `*` or `?`: `*` and `?` within one segment, `**` across segments. */
  path?: string
}

const given = (list: string[] | undefined): list is string[] => list !== undefined && list.length > 0

/**
 * A `since`/`until` bound on `column`, an `updated_at` (#446): a bound that is
 * no date matches nothing, as in `passesFilters`. Both sides are compared at
 * millisecond precision (`timeBound` and graph nodes' `updatedAt` hold no
 * more), so search and graph agree on a change within a bound's millisecond.
 */
function updatedBound(column: SQL, op: SQL, value: string): SQL {
  const bound = timeBound(value)
  return bound === null ? sql`AND false` : sql`AND date_trunc('milliseconds', ${column}) ${op} ${bound}::timestamptz`
}

/** Glob `glob` as an anchored POSIX regular expression (see `SearchFilters.path`). */
function globRegex(glob: string): string {
  let re = '^'
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*' && glob[i + 1] === '*') {
      // `**/` is any number of whole segments, none included; a trailing `**` is anything.
      const segments = glob[i + 2] === '/'
      re += segments ? '(.*/)?' : '.*'
      i += segments ? 2 : 1
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.^$+(){}[\]|\\]/g, '\\$&')
  }
  return `${re}$`
}

/** The filters every resource has: `updated` (`since`/`until`) and `path`. */
function commonClauses(filters: SearchFilters, updatedAt: SQL, path: SQL): SQL[] {
  const clauses: SQL[] = []
  if (filters.since) clauses.push(updatedBound(updatedAt, sql`>=`, filters.since))
  if (filters.until) clauses.push(updatedBound(updatedAt, sql`<=`, filters.until))
  if (filters.path) clauses.push(/[*?]/.test(filters.path) ? sql`AND ${path} ~ ${globRegex(filters.path)}` : sql`AND starts_with(${path}, ${filters.path})`)
  return clauses
}

/**
 * A leg's filter clauses, appended to its WHERE: `null` when no row of its
 * kind can match (the leg then runs no query), `[]` when nothing is filtered.
 */
type LegFilter = SQL[] | null

/** Over `notes`. */
function noteFilter(filters: SearchFilters): LegFilter {
  if (given(filters.languages) || given(filters.kinds)) return null
  const clauses: SQL[] = []
  if (given(filters.types)) clauses.push(sql`AND notes.type = ANY(${textArray(filters.types)})`)
  // A tag is a string element of a frontmatter `tags` array, as `passesFilters` reads it.
  if (given(filters.tags)) {
    clauses.push(sql`AND jsonb_typeof(notes.frontmatter -> 'tags') = 'array' AND notes.frontmatter -> 'tags' ?| ${textArray(filters.tags)}`)
  }
  return [...clauses, ...commonClauses(filters, sql`notes.updated_at`, sql`notes.path`)]
}

/** Over repository file `f`. */
function fileFilter(filters: SearchFilters): LegFilter {
  if (given(filters.tags) || given(filters.kinds)) return null
  const clauses: SQL[] = []
  if (given(filters.types)) clauses.push(sql`AND f.language = ANY(${textArray(filters.types)})`)
  if (given(filters.languages)) clauses.push(sql`AND f.language = ANY(${textArray(filters.languages)})`)
  return [...clauses, ...commonClauses(filters, sql`f.updated_at`, sql`f.path`)]
}

/** Over symbol block `b` of repository file `f`. */
function symbolFilter(filters: SearchFilters): LegFilter {
  if (given(filters.tags)) return null
  const clauses: SQL[] = []
  if (given(filters.types)) clauses.push(sql`AND b.symbol_kind = ANY(${textArray(filters.types)})`)
  if (given(filters.kinds)) clauses.push(sql`AND b.symbol_kind = ANY(${textArray(filters.kinds)})`)
  if (given(filters.languages)) clauses.push(sql`AND f.language = ANY(${textArray(filters.languages)})`)
  return [...clauses, ...commonClauses(filters, sql`f.updated_at`, sql`f.path`)]
}

const clauses = (filter: SQL[]): SQL => (filter.length > 0 ? sql.join(filter, sql` `) : sql``)

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
 * - `results`: in one total order, score descending, then path by UTF-16
 *   code unit (`COLLATE "C"` in SQL), then resource type (`code`, `note`,
 *   `symbol`), then a symbol's start line, then id (#623).
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
/**
 * The `hnsw.ef_search` of a vector leg over `blocks` (HNSW returns at most
 * that many rows, and each leg keeps only some kinds: file-level blocks, or
 * symbol blocks, so the default 40 would leave it short of `CANDIDATES`).
 */
const BLOCK_CANDIDATES = 200

/**
 * A vector leg over `blocks` (#462): its HNSW search widened to
 * `BLOCK_CANDIDATES` (the default 40 would cap it) and iterative where
 * pgvector has it (`setHnswScan`); each leg re-sorts its cut (`gated`).
 */
async function blockLeg(query: SQL): Promise<unknown> {
  return db.transaction(async (tx) => {
    await setHnswScan(tx, BLOCK_CANDIDATES)
    return tx.execute(query)
  })
}

/** A symbol block `b`'s bare name: `inner_path` without its `symbol_parent.` prefix. */
const SYMBOL_NAME = sql.raw(`CASE WHEN b.symbol_parent IS NULL THEN b.inner_path ELSE substr(b.inner_path, length(b.symbol_parent) + 2) END`)

/** The columns of a symbol hit from block `b` of file `f`; the snippet is the one code-blocks.ts stored and embedded. */
const SYMBOL_COLUMNS = sql`b.id, b.owner_id AS file_id, b.container_id, f.path, ${SYMBOL_NAME} AS name,
  b.symbol_kind AS kind, b.symbol_parent AS parent, b.start_line, b.end_line, coalesce(b.snippet, ${SYMBOL_NAME}) AS snippet, ${UPDATED_AT(sql`f.updated_at`)}`

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
 * first, so the HNSW index serves it, then by the leg's tie-break), cut at the
 * relevance gate (#441) and re-sorted by distance then `ties`.
 */
function gated(nearest: SQL, ties: SQL = sql`path COLLATE "C", id`): SQL {
  return sql`
    SELECT * FROM (${nearest} LIMIT ${CANDIDATES}) nearest
    WHERE distance < ${config.searchMaxDistance}
    ORDER BY distance, ${ties}`
}

async function noteRows(vaultIds: string[], query: string, mode: 'keyword' | 'semantic', vec: string | undefined, filter: LegFilter): Promise<Row[]> {
  if (vaultIds.length === 0 || filter === null) return []
  const filterSql = clauses(filter)
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
      : await blockLeg(
          gated(sql`
            -- A note's vector rank is its best block's distance (ADR-004 §2.5 roll-up): one row per note, as before
            -- blocks; #967's relevance gate applies to that best distance. Equal distances at the 200-block cut go by
            -- owner (#623; an Incremental Sort over the index scan, which the HNSW index still serves), the 30-note
            -- cut below by path. Unfiltered, the cut has no join to notes, which would add a lookup per block; a
            -- filter (#454) joins them there, so it runs inside the (iterative, #462) scan, before the cut.
            WITH nearest AS (
              SELECT owner_id, embedding <=> ${vec}::vector AS distance
              FROM blocks ${filter.length > 0 ? sql`JOIN notes ON notes.id = blocks.owner_id AND notes.deleted_at IS NULL ${filterSql}` : sql``}
              WHERE owner_type = 'note' AND container_id = ANY(${uuidArray(vaultIds)}) AND embedding IS NOT NULL
              ORDER BY embedding <=> ${vec}::vector, owner_id
              LIMIT ${BLOCK_CANDIDATES}
            ), best AS (
              SELECT owner_id, min(distance) AS distance FROM nearest GROUP BY owner_id
            )
            SELECT notes.id, notes.vault_id AS container_id, notes.path, notes.type, notes.frontmatter, left(notes.body, 200) AS snippet,
                   ${UPDATED_AT(sql`notes.updated_at`)}, best.distance
            FROM best JOIN notes ON notes.id = best.owner_id
            WHERE notes.deleted_at IS NULL
            ORDER BY best.distance, notes.path COLLATE "C", notes.id`),
        )
  return rows as unknown as Row[]
}

async function codeRows(repositoryIds: string[], query: string, mode: 'keyword' | 'semantic', vec: string | undefined, filter: LegFilter): Promise<Row[]> {
  if (repositoryIds.length === 0 || filter === null) return []
  const filterSql = clauses(filter)
  // ponytail: CTE wraps candidate search so ts_headline only runs on top 30 files (DB-12).
  const rows =
    mode === 'keyword'
      ? await db.execute(sql`
          WITH top_code AS (
            SELECT id, repository_id AS container_id, path, language, content, ${UPDATED_AT(sql`updated_at`)},
                   ts_rank(fts, websearch_to_tsquery('english', ${query})) AS rank
            FROM repository_files f
            WHERE repository_id = ANY(${uuidArray(repositoryIds)})
              AND fts @@ websearch_to_tsquery('english', ${query})
              ${filterSql}
            ORDER BY rank DESC, path COLLATE "C", id
            LIMIT ${CANDIDATES}
          )
          SELECT id, container_id, path, language, updated_at,
                 ts_headline('english', content, websearch_to_tsquery('english', ${query}),
                             'MaxWords=30, MinWords=10') AS snippet
          FROM top_code
          ORDER BY rank DESC, path COLLATE "C", id
        `)
      : await blockLeg(
          gated(sql`
            -- A file's vector rank is its file block's (path and content, the old file vector): one row per file,
            -- as before blocks. The ADR-004 §2.5 best-block roll-up ranked chapters A6 and A13 out of the top 5 (bench
            -- run 40063746649, hit@5 0.9655 -> 0.8966), and the outline of a large file did A13 (run 40068837408,
            -- 0.931). #967's relevance gate applies to that block's distance.
            SELECT f.id, f.repository_id AS container_id, f.path, f.language, left(f.content, 200) AS snippet,
                   ${UPDATED_AT(sql`f.updated_at`)}, b.embedding <=> ${vec}::vector AS distance
            FROM blocks b JOIN repository_files f ON f.id = b.owner_id
            -- kind = 'file' alone (only code has file blocks): naming owner_type too would let the planner take the
            -- owner_type = 'code' index (migration 0036), whose post-filter is what the files-only index avoids.
            WHERE b.kind = 'file' AND b.container_id = ANY(${uuidArray(repositoryIds)}) AND b.embedding IS NOT NULL ${filterSql}
            ORDER BY b.embedding <=> ${vec}::vector, f.path COLLATE "C", f.id`),
        )
  return rows as unknown as Row[]
}

async function symbolRows(
  repositoryIds: string[],
  query: string,
  mode: 'keyword' | 'semantic',
  vec: string | undefined,
  filter: LegFilter,
): Promise<SymbolRow[]> {
  if (repositoryIds.length === 0 || filter === null) return []
  const repos = uuidArray(repositoryIds)
  const filterSql = clauses(filter)
  const pattern = `%${query}%`
  const rows =
    mode === 'keyword'
      ? await db.execute(sql`
          -- By name, by Class.name (inner_path), or by snippet, as the symbol table was matched before blocks.
          SELECT ${SYMBOL_COLUMNS}
          FROM blocks b JOIN repository_files f ON f.id = b.owner_id
          WHERE b.owner_type = 'code' AND b.kind = 'symbol' AND b.container_id = ANY(${repos}) ${filterSql}
            AND (b.inner_path ILIKE ${pattern} OR (b.snippet IS NOT NULL AND b.snippet ILIKE ${pattern}))
          ORDER BY
            CASE
              WHEN lower(${SYMBOL_NAME}) = lower(${query}) OR lower(b.inner_path) = lower(${query}) THEN 1
              WHEN lower(${SYMBOL_NAME}) LIKE lower(${`${query}%`}) THEN 2
              ELSE 3
            END,
            f.path COLLATE "C", b.start_line, b.id
          LIMIT ${CANDIDATES}
        `)
      : await blockLeg(
          gated(sql`
            SELECT ${SYMBOL_COLUMNS}, b.embedding <=> ${vec}::vector AS distance
            FROM blocks b JOIN repository_files f ON f.id = b.owner_id
            -- kind = 'symbol' alone, so the planner takes the symbols-only index (see codeRows).
            WHERE b.kind = 'symbol' AND b.container_id = ANY(${repos}) ${filterSql}
              AND b.embedding IS NOT NULL
            ORDER BY b.embedding <=> ${vec}::vector, f.path COLLATE "C", b.start_line, b.id`,
            sql`path COLLATE "C", start_line, id`,
          ),
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

interface Ranked {
  score: number
  path: string
  resourceType?: ResourceType
  startLine?: number
  id: string
}

/**
 * The total order of every answer: score descending, then path by code unit,
 * then resource type (a note and a code file can share a path; a file sorts
 * before its symbols), then a symbol's start line, then id. Ids are random per
 * instance, so they decide only what the rest leaves tied (#623).
 */
function byScore(a: Ranked, b: Ranked): number {
  return (
    b.score - a.score ||
    compareCodeUnits(a.path, b.path) ||
    compareCodeUnits(a.resourceType ?? '', b.resourceType ?? '') ||
    (a.startLine ?? 0) - (b.startLine ?? 0) ||
    compareCodeUnits(a.id, b.id)
  )
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
  const filter = symbolFilter({ kinds: options?.kind ? [options.kind] : undefined })

  const state = indexState([], repositoryIds)
  const vec = await queryVector(query)
  const [keyword, vector] = await Promise.all([
    channel<[SymbolRow[]]>('keyword', [symbolRows(repositoryIds, query, 'keyword', undefined, filter)]),
    vec === null ? null : channel<[SymbolRow[]]>('vector', [symbolRows(repositoryIds, query, 'semantic', vec, filter)]),
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
  filters: SearchFilters = {},
  options: SearchNotesOptions = {},
): Promise<SearchResponse<SearchResult>> {
  const { vaultIds, repositoryIds } = resources
  if ((vaultIds.length === 0 && repositoryIds.length === 0) || query.trim() === '') return { ...NOTHING, results: [] }

  const includeSymbols = options.includeSymbols ?? false
  const symbolRepos = includeSymbols ? repositoryIds : []
  const state = indexState(vaultIds, repositoryIds)
  const [notes, files, symbols] = [noteFilter(filters), fileFilter(filters), symbolFilter(filters)]
  const vec = await queryVector(query)
  const [keyword, vector] = await Promise.all([
    channel<[Row[], Row[], SymbolRow[]]>('keyword', [
      noteRows(vaultIds, query, 'keyword', undefined, notes),
      codeRows(repositoryIds, query, 'keyword', undefined, files),
      symbolRows(symbolRepos, query, 'keyword', undefined, symbols),
    ]),
    vec === null
      ? null
      : channel<[Row[], Row[], SymbolRow[]]>('vector', [
          noteRows(vaultIds, query, 'semantic', vec, notes),
          codeRows(repositoryIds, query, 'semantic', vec, files),
          symbolRows(symbolRepos, query, 'semantic', vec, symbols),
        ]),
  ])

  // Reciprocal Rank Fusion — rank-based, no score normalization to tune.
  const merged = new Map<string, SearchResult>()
  const contribute = (resourceType: ResourceType, rows: Row[], preferSnippet: boolean): void => {
    rows.forEach((row, rank) => {
      const key = `${resourceType}:${row.id}`
      const contribution = 1 / (RRF_K + rank + 1)
      const existing = merged.get(key)
      if (existing) {
        existing.score += contribution
        if (preferSnippet) existing.snippet = row.snippet
      } else {
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

  // Every filter already applied inside the legs (#454).
  return respond([...merged.values()].sort(byScore).slice(0, limit), vec !== null, keyword, vector, await state)
}
