import { sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { config } from '../config.js'
import { textArray } from './block-rows.js'
import { embedQuery } from './embeddings.js'
import { embeddingState } from './embedding-queue.js'
import { setHnswScan } from './hnsw.js'
import { MAX_KEYWORD_LENGTH, isPlainWord, keywordTerms, splitIdentifier, type Identifier } from './identifiers.js'
import { extractionState } from '../repositories/extraction-queue.js'
import { timeBound, type GraphFilters } from '../graph/assemble.js'
import { compareCodeUnits } from '../mcp/response.js'

function uuidArray(ids: string[]): SQL {
  // ponytail: single Postgres array parameter literal instead of N placeholders (DB-07).
  return sql`${`{${ids.join(',')}}`}::uuid[]`
}

/** The English full-text query of `text`, as every keyword leg ran it before #455 (note legs still do). */
const english = (text: string): SQL => sql`websearch_to_tsquery('english', ${text})`

/**
 * A query of one exact lexeme: quoted, so no parser or stemming touches it. One longer than
 * `MAX_KEYWORD_LENGTH` is never stored, and Postgres refuses a tsquery word over 2,047 bytes: the empty query.
 */
const lexeme = (l: string): SQL =>
  l.length > MAX_KEYWORD_LENGTH ? sql`''::tsquery` : sql`${`'${l.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`}::tsquery`

/** All of `queries` (empty: the empty query, which `&&` ignores). Every operand is parenthesised: `||` and `&&` bind alike in SQL. */
function allOf(queries: SQL[]): SQL {
  return queries.length === 0 ? sql`''::tsquery` : sql.join(
    queries.map((q) => sql`(${q})`),
    sql` && `,
  )
}

/** A word: its English query or the unstemmed `lexemes`; nothing when it is a stop word (as the English query drops it). */
function word(text: string, lexemes: SQL): SQL {
  return sql`CASE WHEN numnode(${english(text)}) = 0 THEN ''::tsquery ELSE (${english(text)}) || (${lexemes}) END`
}

/**
 * The spellings of a compound that match it (#455): its whole lexeme and its
 * parts joined plain (how a camelCase or PascalCase word is stored), by `_`
 * (snake_case, SCREAMING_SNAKE_CASE) and by `-` (kebab-case), so
 * `parseFrontmatter` and `parse_frontmatter` find each other.
 */
function spellings(id: Identifier): SQL {
  return sql.join([...new Set([id.whole, id.parts.join(''), id.parts.join('_'), id.parts.join('-')])].map(lexeme), sql` || `)
}

/**
 * The code and symbol keyword legs' query (#455): `match` is every query
 * term, each as its English query (stemmed, as before) or as its
 * identifiers (search/identifiers.ts): a plain word unstemmed, so
 * `frontmatter parse` finds `parseFrontmatter`; a compound as one of its
 * `spellings`, so `parse_frontmatter` finds `parseFrontmatter` and
 * `mcp.server.ts` finds `src/mcp/server.ts`. In the symbol leg, whose
 * document is one name path, a compound also matches as all its parts
 * (`reader.load_body` finds `NoteReader.loadBody`). The code leg's document
 * is a whole file, so there a term matches as written: not a compound by
 * its parts, nor a term of several plain words (`host/platform`) by its
 * words; it keeps that term's English query. Their pieces anywhere in a
 * file matched every long document that uses the words, and the fusion
 * ranked those above the file that defines the name (the benchmark
 * regression of #1014: `HopperRequestQueue` in a question matched guides
 * with hopper, request and queue in them). `whole` is any compound's whole
 * lexeme: a leg ranks those matches first. A query with
 * `websearch_to_tsquery` syntax keeps the English query and has no `whole`.
 */
function keywordQuery(query: string, leg: 'code' | 'symbol'): { match: SQL; whole: SQL | null } {
  const terms = keywordTerms(query)
  if (terms === null) return { match: english(query), whole: null }
  const wholes = new Set<string>()
  const match = allOf(
    terms.map(({ text, identifiers }) => {
      if (identifiers.every(isPlainWord)) {
        if (leg === 'code' && identifiers.length > 1) return english(text)
        return word(text, allOf(identifiers.map((id) => lexeme(id.whole))))
      }
      const alternatives = identifiers.map((id) => {
        if (isPlainWord(id)) return word(id.whole, lexeme(id.whole))
        if (id.whole.length <= MAX_KEYWORD_LENGTH) wholes.add(id.whole)
        return leg === 'code' ? spellings(id) : sql`(${lexeme(id.whole)}) || (${allOf(id.parts.map((p) => word(p, lexeme(p))))})`
      })
      return sql`(${english(text)}) || (${allOf(alternatives)})`
    }),
  )
  return { match, whole: wholes.size === 0 ? null : sql.join([...wholes].map(lexeme), sql` || `) }
}

/**
 * The code keyword leg's document (#455), as `repository_files_keyword_idx` indexes it: `keyword_fts` (the
 * English `fts` plus the identifier lexemes, written by extraction) while it is of the current content and was
 * written by an extractor that has keywords (6, the version that added them, as a literal: the index has it;
 * code from before 0052 re-extracting a file after a rollback writes a lower version), else `fts`.
 */
const CODE_DOCUMENT = sql.raw(
  `(CASE WHEN keyword_fts IS NOT NULL AND extracted_hash = content_hash AND extractor_version >= 6 THEN keyword_fts ELSE fts END)`,
)

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
  /** The asking account: its repeated queries come from the query-embedding cache (#684). Without it nothing is cached. */
  accountId?: string
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

/**
 * The fixed candidate window per leg merged by Reciprocal Rank Fusion (#456).
 * 60 candidates per leg ensures exact and identifier matches down the tail of
 * each leg reach fusion, while keeping fusion bounded and deterministic.
 */
const RRF_WINDOW = 60
const CANDIDATES = RRF_WINDOW
const RRF_K = 60
/** Exact and identifier matches always outrank fuzzy ones in fusion (#456). */
const EXACT_BOOST = 1
/** Bounded boost for code hits over docs/plans on code-shaped queries (#457). */
const CODE_BOOST = 0.0008
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
  const keyword = keywordQuery(query, 'code')
  // ponytail: CTE wraps candidate search so ts_headline only runs on top 30 files (DB-12).
  const rows =
    mode === 'keyword'
      ? await db.execute(sql`
          -- #455: the whole identifier first, then the English match by its rank
          -- (the order before identifiers), then what only the identifier keywords match (parts of a name, a path
          -- segment), by their rank. A row the English query does not match gets the vector leg's snippet: its
          -- headline would highlight nothing and parse the whole file (about 20 ms a file on rea's larger files).
          WITH top_code AS (
            SELECT id, repository_id AS container_id, path, language, content, ${UPDATED_AT(sql`updated_at`)},
                   ${keyword.whole ? sql`${CODE_DOCUMENT} @@ (${keyword.whole})` : sql`false`} AS whole,
                   CASE WHEN fts @@ ${english(query)} THEN ts_rank(fts, ${english(query)}) END AS rank,
                   ts_rank(${CODE_DOCUMENT}, ${keyword.match}) AS keyword_rank
            FROM repository_files f
            WHERE repository_id = ANY(${uuidArray(repositoryIds)})
              AND ${CODE_DOCUMENT} @@ (${keyword.match})
              ${filterSql}
            ORDER BY whole DESC, rank DESC NULLS LAST, keyword_rank DESC, path COLLATE "C", id
            LIMIT ${CANDIDATES}
          )
          SELECT id, container_id, path, language, updated_at,
                 CASE WHEN rank IS NULL THEN left(content, 200)
                   ELSE ts_headline('english', content, ${english(query)}, 'MaxWords=30, MinWords=10') END AS snippet
          FROM top_code
          ORDER BY whole DESC, rank DESC NULLS LAST, keyword_rank DESC, path COLLATE "C", id
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
  const keyword = keywordQuery(query, 'symbol')
  const contains = sql`(b.inner_path ILIKE ${pattern} OR (b.snippet IS NOT NULL AND b.snippet ILIKE ${pattern}))`
  const rows =
    mode === 'keyword'
      ? await db.execute(sql`
          -- By name, by Class.name (inner_path), or by snippet, as the symbol table was matched before blocks; or
          -- by the identifier keywords of its inner_path and file path (#455), ranked after those, the whole
          -- identifier before its parts.
          SELECT ${SYMBOL_COLUMNS}
          FROM blocks b JOIN repository_files f ON f.id = b.owner_id
          WHERE b.owner_type = 'code' AND b.kind = 'symbol' AND b.container_id = ANY(${repos}) ${filterSql}
            AND (${contains} OR b.keywords @@ (${keyword.match}))
          ORDER BY
            CASE
              WHEN lower(${SYMBOL_NAME}) = lower(${query}) OR lower(b.inner_path) = lower(${query}) THEN 1
              WHEN lower(${SYMBOL_NAME}) LIKE lower(${`${query}%`}) THEN 2
              WHEN ${contains} THEN 3
              ${keyword.whole ? sql`WHEN b.keywords @@ (${keyword.whole}) THEN 4` : sql``}
              ELSE 5
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

/**
 * The query's vector as a pgvector literal, or null when the embedder failed: search then answers from the keyword channel (#458).
 * A repeated query of the same account comes from the query cache (#684).
 */
async function queryVector(query: string, accountId: string | undefined): Promise<string | null> {
  try {
    return JSON.stringify(await embedQuery(query, accountId ?? null))
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

const STOP_WORDS: Record<string, true> = {
  a: true, about: true, above: true, after: true, again: true, against: true, all: true,
  am: true, an: true, and: true, any: true, are: true, as: true, at: true,
  be: true, because: true, been: true, before: true, being: true, below: true, between: true, both: true, but: true, by: true,
  can: true, could: true, did: true, do: true, does: true, doing: true, down: true, during: true,
  each: true, few: true, for: true, from: true, further: true,
  had: true, has: true, have: true, having: true, he: true, her: true, here: true, hers: true, herself: true,
  him: true, himself: true, his: true, how: true,
  i: true, if: true, in: true, into: true, is: true, it: true, its: true, itself: true,
  just: true, me: true, more: true, most: true, my: true, myself: true,
  no: true, nor: true, not: true, now: true, of: true, off: true, on: true, once: true, only: true, or: true, other: true, our: true, ours: true, ourselves: true, out: true, over: true, own: true,
  same: true, she: true, should: true, so: true, some: true, such: true,
  than: true, that: true, the: true, their: true, theirs: true, them: true, themselves: true, then: true, there: true, these: true, they: true, this: true, those: true, through: true, to: true, too: true,
  under: true, until: true, up: true, very: true,
  was: true, we: true, were: true, what: true, when: true, where: true, which: true, while: true, who: true, whom: true, why: true, with: true,
  you: true, your: true, yours: true, yourself: true, yourselves: true,
}

/** Common file stems that appear as generic vocabulary in multi-word questions (#456). */
const GENERIC_BASE_STEMS: Record<string, true> = {
  index: true,
  main: true,
  app: true,
  readme: true,
  license: true,
  changelog: true,
  types: true,
  utils: true,
  util: true,
  helpers: true,
  helper: true,
  common: true,
}

interface ExactContext {
  multiWord: boolean
  termSet: Set<string>
  termSetLower: Set<string>
  spellingSet: Set<string>
  queryNorm: string
  queryStripped: string
}

/** Extracts non-stopword query terms and identifier spelling sets for cheap exact-match checks in fusion (#456). */
function queryExactContext(query: string): ExactContext {
  const rawTokens = query.trim().split(/\s+/).filter(Boolean)
  const multiWord = rawTokens.length >= 2
  const termSet = new Set<string>()
  const termSetLower = new Set<string>()
  const spellingSet = new Set<string>()

  for (const raw of rawTokens) {
    const rawLower = raw.toLowerCase()
    const cleaned = raw.replace(/^[^\p{L}\p{N}_$]+|[^\p{L}\p{N}_$]+$/gu, '')
    const cleanedLower = cleaned.toLowerCase()

    // Common stopwords never grant exact-match priority.
    if (cleanedLower in STOP_WORDS || cleanedLower.length <= 1) continue

    termSet.add(raw)
    termSetLower.add(rawLower)
    if (cleaned.length > 0) {
      termSet.add(cleaned)
      termSetLower.add(cleanedLower)
      const id = splitIdentifier(cleaned)
      for (const s of [id.whole, id.parts.join(''), id.parts.join('_'), id.parts.join('-')]) {
        if (s.length > 0 && !(s in STOP_WORDS)) spellingSet.add(s)
      }
    }
    const idRaw = splitIdentifier(raw)
    for (const s of [idRaw.whole, idRaw.parts.join(''), idRaw.parts.join('_'), idRaw.parts.join('-')]) {
      if (s.length > 0 && !(s in STOP_WORDS)) spellingSet.add(s)
    }
  }

  const queryNorm = query.trim().toLowerCase()
  const queryStripped = queryNorm.replace(/^[^\p{L}\p{N}_$/.-]+|[^\p{L}\p{N}_$/.-]+$/gu, '').trim()
  return { multiWord, termSet, termSetLower, spellingSet, queryNorm, queryStripped }
}

/** A symbol whose name equals a query term, case-sensitively or by spelling set from identifiers.ts (#456). */
function isExactSymbol(name: string, parent: string | null | undefined, ctx: ExactContext): boolean {
  const lower = name.toLowerCase()
  if (lower in STOP_WORDS || lower.length <= 1) return false
  if (ctx.termSet.has(name)) return true
  if (ctx.spellingSet.has(lower)) return true
  if (parent) {
    const fullName = `${parent}.${name}`
    if (ctx.termSet.has(fullName) || ctx.spellingSet.has(fullName.toLowerCase())) return true
  }
  return false
}

/** A file whose path or basename equals a term (#456). */
function isExactFile(path: string, ctx: ExactContext): boolean {
  const lower = path.toLowerCase()
  if (ctx.termSet.has(path) || ctx.termSetLower.has(lower)) return true
  const base = path.split('/').pop() ?? path
  const baseLower = base.toLowerCase()
  if (ctx.termSet.has(base) || ctx.termSetLower.has(baseLower)) return true
  // In multi-word questions, a generic stem (like index in index.ts) does not match unless typed with extension.
  const stem = baseLower.replace(/(.)\.[^.]*$/, '$1')
  if (ctx.multiWord && stem in GENERIC_BASE_STEMS) return false
  if (ctx.termSetLower.has(stem)) return true
  return false
}

/** Extracts the lowercased note title from frontmatter, if present and string-typed. */
function noteTitle(frontmatter: unknown): string {
  if (frontmatter && typeof frontmatter === 'object' && 'title' in frontmatter && typeof frontmatter.title === 'string') {
    return frontmatter.title.trim().toLowerCase()
  }
  return ''
}

/** A note whose title or path equals the query (#456). */
function isExactNote(path: string, frontmatter: unknown, ctx: ExactContext): boolean {
  const pathNorm = path.trim().toLowerCase()
  if (pathNorm === ctx.queryNorm || (ctx.queryStripped.length > 0 && pathNorm === ctx.queryStripped)) return true
  const title = noteTitle(frontmatter)
  if (title !== '' && (title === ctx.queryNorm || (ctx.queryStripped.length > 0 && title === ctx.queryStripped))) return true
  return false
}

const PROSE_TERMS: Record<string, true> = {
  github: true, webassembly: true, javascript: true, typescript: true, postgresql: true, mongodb: true,
  graphql: true, devops: true, openai: true, chatgpt: true, anthropic: true, claude: true, gemini: true,
  vscode: true, nextjs: true, nuxtjs: true, nodejs: true, fastapi: true, dockerhub: true, macos: true,
  ios: true, ipados: true, watchos: true, iphone: true, ipad: true, imac: true, quicktime: true, webkit: true,
  apis: true, uuids: true, urls: true, uris: true, sdks: true, adrs: true, prs: true, ips: true, vms: true, dbs: true, cpus: true, gpus: true,
  'and/or': true, 'curl/wget': true, 'node/v8': true, 'input/output': true, 'read/write': true, 'client/server': true,
  'true/false': true, 'yes/no': true, 'on/off': true, 'up/down': true, 'in/out': true, 'either/or': true, 'before/after': true,
}

const CODE_EXTENSIONS = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|c|cpp|cc|cxx|h|hpp|rb|php|cs|swift|kt|scala|sh|bash|sql)$/i
const CODE_PATH = /(?:^|\/)(?:src|server|client|lib|crates|pkg|internal)\/[a-zA-Z0-9_.-]+/i
const DECL_KEYWORD = /\b(?:function|def|fn|class|interface|struct|enum)\s+[a-zA-Z_$][a-zA-Z0-9_$]*/i
const CAMEL_IDENTIFIER = /(?:\p{Ll}\p{Lu}|\p{Lu}{2,}\p{Ll})/u
const SNAKE_IDENTIFIER = /^[a-zA-Z0-9]+_[a-zA-Z0-9_]+$/

/**
 * Classifies whether a query is code-shaped (#457) based on explicit syntactic
 * features (code file extensions, paths in source trees, declaration constructs).
 * Architectural rationale questions ('why') and pure prose queries remain untouched.
 */
export function isCodeShaped(query: string): boolean {
  const qLower = query.trim().toLowerCase()
  if (/^(?:why\b|how\s+come\b)/i.test(qLower)) return false
  if (DECL_KEYWORD.test(query)) return true

  const tokens = query.trim().split(/\s+/).filter(Boolean)
  let signals = 0
  let strongSignal = false

  for (const token of tokens) {
    const cleaned = token.replace(/^[^\p{L}\p{N}_$]+|[^\p{L}\p{N}_$]+$/gu, '')
    const cleanedLower = cleaned.toLowerCase()
    const tokenLower = token.toLowerCase()

    if (cleanedLower in PROSE_TERMS || tokenLower in PROSE_TERMS) continue

    if (CODE_EXTENSIONS.test(cleaned)) {
      strongSignal = true
      signals += 2
      continue
    }

    if (CODE_PATH.test(token)) {
      strongSignal = true
      signals += 2
      continue
    }

    if (CAMEL_IDENTIFIER.test(cleaned) && !cleanedLower.endsWith('s') && cleaned.length >= 4) {
      signals += 1
    }

    if (SNAKE_IDENTIFIER.test(cleaned) && cleaned.length >= 5) {
      signals += 1
    }
  }

  return strongSignal || signals >= 2
}

/** Whether a hit represents documentation/prose rather than executable source code (#457). */
function isDocHit(resourceType: ResourceType, path: string): boolean {
  if (resourceType === 'note') return true
  if (resourceType === 'symbol') return false
  const lower = path.toLowerCase()
  if (/\.(?:md|markdown|mdx|rst|txt|adoc|org)$/i.test(lower)) return true
  if (/(?:^|\/)(?:docs?|plans?|wiki|specs?)(?:\/|$)/i.test(lower)) return true
  const base = lower.split('/').pop() ?? lower
  if (/^(?:readme|changelog|contributing|license|notice)(?:\..+)?$/i.test(base)) return true
  return false
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
    /** As `SearchNotesOptions.accountId`. */
    accountId?: string
  },
): Promise<SearchResponse<SymbolSearchResult>> {
  if (repositoryIds.length === 0 || query.trim() === '') return { ...NOTHING, results: [] }
  const limit = options?.limit ?? 20
  const filter = symbolFilter({ kinds: options?.kind ? [options.kind] : undefined })

  const state = indexState([], repositoryIds)
  const vec = await queryVector(query, options?.accountId)
  const [keyword, vector] = await Promise.all([
    channel<[SymbolRow[]]>('keyword', [symbolRows(repositoryIds, query, 'keyword', undefined, filter)]),
    vec === null ? null : channel<[SymbolRow[]]>('vector', [symbolRows(repositoryIds, query, 'semantic', vec, filter)]),
  ])

  const ctx = queryExactContext(query)
  const map = new Map<string, SymbolSearchResult>()
  const contribute = (rows: SymbolRow[], preferSnippet: boolean) => {
    rows.slice(0, RRF_WINDOW).forEach((row, rank) => {
      const contribution = 1 / (RRF_K + rank + 1)
      const existing = map.get(row.id)
      if (existing) {
        existing.score += contribution
        if (preferSnippet && row.snippet) existing.snippet = row.snippet
      } else {
        const exact = isExactSymbol(row.name, row.parent, ctx)
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
          score: contribution + (exact ? EXACT_BOOST : 0),
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
  const vec = await queryVector(query, options.accountId)
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
  const ctx = queryExactContext(query)
  const codeShaped = isCodeShaped(query)
  const codeBoost = (resourceType: ResourceType, path: string): number =>
    codeShaped && !isDocHit(resourceType, path) ? CODE_BOOST : 0
  const merged = new Map<string, SearchResult>()
  const contribute = (resourceType: ResourceType, rows: Row[], preferSnippet: boolean): void => {
    rows.slice(0, RRF_WINDOW).forEach((row, rank) => {
      const key = `${resourceType}:${row.id}`
      const contribution = 1 / (RRF_K + rank + 1)
      const existing = merged.get(key)
      if (existing) {
        existing.score += contribution
        if (preferSnippet) existing.snippet = row.snippet
      } else {
        const exact = resourceType === 'note' ? isExactNote(row.path, row.frontmatter, ctx) : isExactFile(row.path, ctx)
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
          score: contribution + (exact ? EXACT_BOOST : 0) + codeBoost(resourceType, row.path),
        })
      }
    })
  }

  const contributeSymbols = (rows: SymbolRow[], preferSnippet: boolean): void => {
    rows.slice(0, RRF_WINDOW).forEach((row, rank) => {
      const key = `symbol:${row.id}`
      const contribution = 1 / (RRF_K + rank + 1)
      const existing = merged.get(key)
      if (existing) {
        existing.score += contribution
        if (preferSnippet && row.snippet) existing.snippet = row.snippet
      } else {
        const exact = isExactSymbol(row.name, row.parent, ctx)
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
          score: contribution + (exact ? EXACT_BOOST : 0) + (codeShaped ? CODE_BOOST : 0),
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
