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
 * One term of a keyword leg's query (#455 part 2), what the relaxation ladder (`ladder`) and the trigram leg
 * (`similarity`) work with when the leg's AND query matches too little.
 */
interface Term {
  /** The term's query in its leg; the leg's AND query is all of them. */
  query: SQL
  /** It holds a compound (`parseFrontmatter`, `mcp.server.ts`): among terms as rare, kept before a plain word. */
  compound: boolean
  /**
   * What the trigram leg matches, should the term match nothing: its identifiers' wholes (a typo'd identifier, or a
   * plain word), `MIN_SIMILAR_LENGTH` characters or more. The leg runs only when nothing else matched.
   */
  spelled: string[]
}

/** A shorter term is not matched by trigram similarity: a short word is similar to too many names. */
const MIN_SIMILAR_LENGTH = 5

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
 * lexeme: a leg ranks those matches first. `terms` are the terms one by one
 * (a repeated term once). A query with `websearch_to_tsquery` syntax keeps
 * the English query and has no `whole` and no `terms`: it is not relaxed.
 */
function keywordQuery(query: string, leg: 'code' | 'symbol'): { match: SQL; whole: SQL | null; terms: Term[] | null } {
  const typed = keywordTerms(query)
  if (typed === null) return { match: english(query), whole: null, terms: null }
  const wholes = new Set<string>()
  const seen = new Set<string>()
  const terms: Term[] = []
  for (const { text, identifiers } of typed) {
    if (seen.has(text.toLowerCase())) continue
    seen.add(text.toLowerCase())
    const compound = !identifiers.every(isPlainWord)
    const spelled = identifiers.map((id) => id.whole).filter((w) => w.length >= MIN_SIMILAR_LENGTH && w.length <= MAX_KEYWORD_LENGTH)
    terms.push({ query: termQuery(text, identifiers, leg, wholes), compound, spelled })
  }
  return {
    match: allOf(terms.map((t) => t.query)),
    whole: wholes.size === 0 ? null : sql.join([...wholes].map(lexeme), sql` || `),
    terms,
  }
}

/** One term's query in `leg` (`keywordQuery`); adds the whole lexemes of its compounds to `wholes`. */
function termQuery(text: string, identifiers: Identifier[], leg: 'code' | 'symbol', wholes: Set<string>): SQL {
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
}

/** The note leg's terms (#455 part 2): each whitespace-separated term's English query; null for websearch syntax. */
function noteTerms(query: string): Term[] | null {
  const typed = keywordTerms(query)
  if (typed === null) return null
  const texts = [...new Map(typed.map(({ text }) => [text.toLowerCase(), text])).values()]
  return texts.map((text) => ({ query: english(text), compound: false, spelled: [] }))
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
 * A code file's fields (#455 part 2, migration 0059): `keyword_head`, its path's and its symbols' name lexemes,
 * while it is of the current content and was written by an extractor that has it (7); else none.
 */
const CODE_FIELDS = sql.raw(`(CASE WHEN extracted_hash = content_hash AND extractor_version >= 7 THEN keyword_head END)`)

/** A note's fields (#455 part 2): its path's words and its frontmatter title, English; generated (migration 0059). */
const NOTE_FIELDS = sql.raw(`notes.field_fts`)

/**
 * How many of the terms a row's `fields` match (#455 part 2): a leg orders its matches by it before their body
 * rank, so a term in a path, a note title or a declared name counts above the same term in a body. A query
 * without terms (websearch syntax) counts its whole `match` once.
 */
function fieldHits(fields: SQL, terms: Term[] | null, match: SQL): SQL {
  return sql.join(
    (terms ?? [{ query: match }]).map(({ query }) => sql`coalesce((${fields} @@ (${query}))::int, 0)`),
    sql` + `,
  )
}

/** Terms the ladder keeps at most, the rarest: a row's ladder rank is a bit per term. */
const MAX_LADDER = 30

/** A leg's terms sorted for the relaxation ladder: `live`, rarest first; `missing`, those that match nothing. */
interface Ladder {
  live: Term[]
  missing: Term[]
}

/**
 * The ladder of `terms` over a leg's rows (#455 part 2): each term's document frequency in the `fields` of the
 * rows of `scope` (`FROM ... WHERE ...`, the leg's own, filters included), counted in one pass (fields are
 * small, and have no index). A stop word (an empty query) is in neither list. Among terms as rare a compound
 * comes first, then the query's order. `missing` are the terms no row's `doc` matches (an `EXISTS` through the
 * document's index), the trigram leg's input; `doc` null: the fields are the whole document (a symbol's name).
 */
async function ladder(scope: SQL, fields: SQL, doc: SQL | null, terms: Term[]): Promise<Ladder> {
  const columns = terms.map(({ query }, i) => {
    const exists = doc ? sql`, EXISTS (SELECT 1 ${scope} AND ${doc} @@ (${query})) AS ${sql.raw(`e${i}`)}` : sql``
    return sql`numnode(${query}) AS ${sql.raw(`n${i}`)}, count(*) FILTER (WHERE scoped.fields @@ (${query}))::int AS ${sql.raw(`d${i}`)}${exists}`
  })
  // The fields once per row (`OFFSET 0`: not inlined into every term's FILTER).
  const [row] = (await db.execute(
    sql`SELECT ${sql.join(columns, sql`, `)} FROM (SELECT ${fields} AS fields ${scope} OFFSET 0) scoped`,
  )) as unknown as Array<Record<string, number | boolean>>
  const counted = terms
    .map((term, i) => ({ term, i, nodes: row![`n${i}`] as number, count: row![`d${i}`] as number, found: doc ? (row![`e${i}`] as boolean) : row![`d${i}`] !== 0 }))
    .filter(({ nodes }) => nodes > 0)
  return {
    live: counted
      .filter(({ count }) => count > 0)
      .sort((a, b) => a.count - b.count || Number(b.term.compound) - Number(a.term.compound) || a.i - b.i)
      .slice(0, MAX_LADDER)
      .map(({ term }) => term),
    missing: counted.filter(({ found }) => !found).map(({ term }) => term),
  }
}

/**
 * A relaxed row's place on the ladder (#455 part 2): one bit per live term, the rarest the highest, so rows
 * that match the rarer terms come first, and among them those that match more.
 */
function ladderRank(fields: SQL, live: Term[]): SQL {
  return sql.join(
    live.map(({ query }, i) => sql`CASE WHEN ${fields} @@ (${query}) THEN ${2 ** (live.length - 1 - i)}::bigint ELSE 0 END`),
    sql` + `,
  )
}

/** Any of `terms`' queries. */
const anyOf = (terms: Term[]): SQL => sql.join(terms.map(({ query }) => sql`(${query})`), sql` || `)

/** `strings`' trigram word similarity to `column` (pg_trgm), the best of them; `<%` is the index's operator. */
function similarity(strings: string[], column: SQL): { matches: SQL; best: SQL } {
  return {
    matches: sql`(${sql.join(strings.map((s) => sql`${s} <% ${column}`), sql` OR `)})`,
    best: sql`greatest(${sql.join(strings.map((s) => sql`word_similarity(${s}, ${column})`), sql`, `)})`,
  }
}

/** The trigram leg's strings (#455 part 2): the spellings of the terms that matched nothing. */
const similarStrings = (missing: Term[]): string[] => [...new Set(missing.flatMap((t) => t.spelled))]

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

const CANDIDATES = 30
/**
 * RRF's k. A keyword leg's relaxed and trigram rows (#455 part 2) rank as if after a full AND list: rank
 * `CANDIDATES + i`, so each contributes less than any row its leg's AND query matched (with their full rank,
 * relaxed rows that only a keyword leg found took the top of the fusion; local bench runs, diagram-design
 * tokens-to-gold +29 %).
 */
const RRF_K = 60
/** Exact and identifier matches always outrank fuzzy ones in fusion (#456). */
const EXACT_BOOST = 1
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
  /** A relaxed or trigram row of a keyword leg (#455 part 2): its fusion rank counts from `CANDIDATES`. */
  relaxed?: true
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
  /** A relaxed or trigram row of a keyword leg (#455 part 2): its fusion rank counts from `CANDIDATES`. */
  relaxed?: true
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

/**
 * Whether a keyword leg looks past its AND rows (#455 part 2): it matched fewer than it keeps (`CANDIDATES`, so
 * it returned every match), and the query has terms (no websearch syntax) to drop, or one term that matched
 * nothing, for the trigram leg.
 */
const looksFurther = (rows: number, terms: Term[] | null): terms is Term[] =>
  rows < CANDIDATES && terms !== null && (terms.length > 1 || rows === 0)

/**
 * The note keyword leg: the English query of the whole query (every word), its matches ordered by how many terms
 * their title and path hold (#455 part 2), then by rank; then, when it matched fewer than `CANDIDATES`, the
 * relaxed rows (`ladder`): those whose title or path match its rarest term but that do not match every term, by
 * the rarer terms they match.
 */
async function noteKeywordRows(vaultIds: string[], query: string, filterSql: SQL): Promise<Row[]> {
  const scope = sql`FROM notes WHERE vault_id = ANY(${uuidArray(vaultIds)}) AND deleted_at IS NULL ${filterSql}`
  const match = english(query)
  const terms = noteTerms(query)
  const field = fieldHits(NOTE_FIELDS, terms, match)
  // ponytail: CTE wraps candidate search so ts_headline only runs on top 30 rows instead of whole table (DB-12, DB-14).
  const rows = (await db.execute(sql`
    WITH top_notes AS (
      SELECT id, vault_id AS container_id, path, type, frontmatter, body, ${UPDATED_AT(sql`updated_at`)},
             ${field} AS field, ts_rank(fts, ${match}) AS rank
      ${scope} AND fts @@ ${match}
      ORDER BY field DESC, rank DESC, path COLLATE "C", id
      LIMIT ${CANDIDATES}
    )
    SELECT id, container_id, path, type, frontmatter, updated_at,
           ts_headline('english', body, ${match}, 'MaxWords=30, MinWords=10') AS snippet
    FROM top_notes
    ORDER BY field DESC, rank DESC, path COLLATE "C", id
  `)) as unknown as Row[]
  if (!looksFurther(rows.length, terms) || terms.length === 1) return rows
  const { live } = await ladder(scope, NOTE_FIELDS, null, terms)
  if (live.length === 0) return rows
  const relaxed = (await db.execute(sql`
    WITH top_notes AS (
      SELECT id, vault_id AS container_id, path, type, frontmatter, body, ${UPDATED_AT(sql`updated_at`)},
             ${ladderRank(NOTE_FIELDS, live)} AS ladder, ts_rank(fts, ${anyOf(live)}, 1) AS rank
      ${scope} AND ${NOTE_FIELDS} @@ (${live[0]!.query}) AND NOT (fts @@ ${match})
      ORDER BY ladder DESC, rank DESC, path COLLATE "C", id
      LIMIT ${CANDIDATES - rows.length}
    )
    SELECT id, container_id, path, type, frontmatter, updated_at,
           ts_headline('english', body, ${anyOf(live)}, 'MaxWords=30, MinWords=10') AS snippet
    FROM top_notes
    ORDER BY ladder DESC, rank DESC, path COLLATE "C", id
  `)) as unknown as Row[]
  return [...rows, ...relaxed.map((r) => ({ ...r, relaxed: true as const }))]
}

async function noteRows(vaultIds: string[], query: string, mode: 'keyword' | 'semantic', vec: string | undefined, filter: LegFilter): Promise<Row[]> {
  if (vaultIds.length === 0 || filter === null) return []
  const filterSql = clauses(filter)
  const rows =
    mode === 'keyword'
      ? await noteKeywordRows(vaultIds, query, filterSql)
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

/**
 * The code keyword leg (#455). Its AND query (`keywordQuery`): the whole identifier first, then how many terms
 * the file's fields hold (its path, the names it declares; #455 part 2), then the English match by its rank (the
 * order before identifiers), then what only the identifier keywords match (parts of a name, a path segment), by
 * their rank. When that matched fewer than `CANDIDATES` (#455 part 2): the relaxed rows (`ladder`), those whose
 * fields match the rarest term but that do not match every term, by the rarer terms their fields match; when
 * nothing matched, the files whose path or symbol names are similar (pg_trgm) to a term no file matches (a
 * typo'd identifier). A row the English query does not match gets the vector leg's snippet: its headline would
 * highlight nothing and parse the whole file (about 20 ms a file on rea's larger files).
 */
async function codeKeywordRows(repositoryIds: string[], query: string, filterSql: SQL): Promise<Row[]> {
  const repos = uuidArray(repositoryIds)
  const keyword = keywordQuery(query, 'code')
  const scope = sql`FROM repository_files f WHERE repository_id = ANY(${repos}) ${filterSql}`
  const whole = keyword.whole ? sql`${CODE_DOCUMENT} @@ (${keyword.whole})` : sql`false`
  const field = fieldHits(CODE_FIELDS, keyword.terms, keyword.match)
  // ponytail: CTE wraps candidate search so ts_headline only runs on top 30 files (DB-12).
  const rows = (await db.execute(sql`
    WITH top_code AS (
      SELECT id, repository_id AS container_id, path, language, content, ${UPDATED_AT(sql`updated_at`)},
             ${whole} AS whole, ${field} AS field,
             CASE WHEN fts @@ ${english(query)} THEN ts_rank(fts, ${english(query)}) END AS rank,
             ts_rank(${CODE_DOCUMENT}, ${keyword.match}) AS keyword_rank
      ${scope} AND ${CODE_DOCUMENT} @@ (${keyword.match})
      ORDER BY whole DESC, field DESC, rank DESC NULLS LAST, keyword_rank DESC, path COLLATE "C", id
      LIMIT ${CANDIDATES}
    )
    SELECT id, container_id, path, language, updated_at,
           CASE WHEN rank IS NULL THEN left(content, 200)
             ELSE ts_headline('english', content, ${english(query)}, 'MaxWords=30, MinWords=10') END AS snippet
    FROM top_code
    ORDER BY whole DESC, field DESC, rank DESC NULLS LAST, keyword_rank DESC, path COLLATE "C", id
  `)) as unknown as Row[]
  if (!looksFurther(rows.length, keyword.terms)) return rows
  const { live, missing } = await ladder(scope, CODE_FIELDS, CODE_DOCUMENT, keyword.terms)
  const relaxed =
    live.length === 0 || keyword.terms.length === 1
      ? []
      : ((await db.execute(sql`
          WITH top_code AS (
            SELECT id, repository_id AS container_id, path, language, content, ${UPDATED_AT(sql`updated_at`)},
                   ${ladderRank(CODE_FIELDS, live)} AS ladder, ${whole} AS whole,
                   ts_rank(${CODE_DOCUMENT}, ${anyOf(live)}, 1) AS keyword_rank
            ${scope} AND ${CODE_FIELDS} @@ (${live[0]!.query}) AND NOT (${CODE_DOCUMENT} @@ (${keyword.match}))
            ORDER BY ladder DESC, whole DESC, keyword_rank DESC, path COLLATE "C", id
            LIMIT ${CANDIDATES - rows.length}
          )
          SELECT id, container_id, path, language, updated_at, left(content, 200) AS snippet
          FROM top_code
          ORDER BY ladder DESC, whole DESC, keyword_rank DESC, path COLLATE "C", id
        `)) as unknown as Row[])
  const found = [...rows, ...relaxed.map((r) => ({ ...r, relaxed: true as const }))]
  const strings = similarStrings(missing)
  if (found.length > 0 || strings.length === 0) return found
  const byPath = similarity(strings, sql`f.path`)
  const byName = similarity(strings, sql`b.inner_path`)
  const similar = (await db.execute(sql`
    WITH hits AS (
      SELECT f.id, ${byPath.best} AS similarity ${scope} AND ${byPath.matches}
      UNION ALL
      SELECT b.owner_id, ${byName.best}
      FROM blocks b JOIN repository_files f ON f.id = b.owner_id
      WHERE b.kind = 'symbol' AND b.container_id = ANY(${repos}) AND ${byName.matches} ${filterSql}
    ), best AS (
      SELECT id, max(similarity) AS similarity FROM hits GROUP BY id
    )
    SELECT f.id, f.repository_id AS container_id, f.path, f.language, left(f.content, 200) AS snippet, ${UPDATED_AT(sql`f.updated_at`)}
    FROM best JOIN repository_files f ON f.id = best.id
    ORDER BY best.similarity DESC, f.path COLLATE "C", f.id
    LIMIT ${CANDIDATES}
  `)) as unknown as Row[]
  return similar.map((r) => ({ ...r, relaxed: true as const }))
}

async function codeRows(repositoryIds: string[], query: string, mode: 'keyword' | 'semantic', vec: string | undefined, filter: LegFilter): Promise<Row[]> {
  if (repositoryIds.length === 0 || filter === null) return []
  const filterSql = clauses(filter)
  const rows =
    mode === 'keyword'
      ? await codeKeywordRows(repositoryIds, query, filterSql)
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

/**
 * The symbol keyword leg: by name, by Class.name (inner_path), or by snippet, as the symbol table was matched
 * before blocks; or by the identifier keywords of its inner_path (#455), ranked after those, the whole identifier
 * before its parts. When that matched fewer than `CANDIDATES` (#455 part 2): the relaxed rows (`ladder`, a
 * symbol's name is its fields); when nothing matched, the symbols whose name path is similar (pg_trgm) to a term
 * no symbol matches, as in `codeKeywordRows`.
 */
async function symbolKeywordRows(repositoryIds: string[], query: string, filterSql: SQL): Promise<SymbolRow[]> {
  const repos = uuidArray(repositoryIds)
  const pattern = `%${query}%`
  const keyword = keywordQuery(query, 'symbol')
  const contains = sql`(b.inner_path ILIKE ${pattern} OR (b.snippet IS NOT NULL AND b.snippet ILIKE ${pattern}))`
  const scope = sql`FROM blocks b JOIN repository_files f ON f.id = b.owner_id
    WHERE b.owner_type = 'code' AND b.kind = 'symbol' AND b.container_id = ANY(${repos}) ${filterSql}`
  const rows = (await db.execute(sql`
    SELECT ${SYMBOL_COLUMNS}
    ${scope} AND (${contains} OR b.keywords @@ (${keyword.match}))
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
  `)) as unknown as SymbolRow[]
  if (!looksFurther(rows.length, keyword.terms)) return rows
  const { live, missing } = await ladder(scope, sql`b.keywords`, null, keyword.terms)
  const relaxed =
    live.length === 0 || keyword.terms.length === 1
      ? []
      : ((await db.execute(sql`
          SELECT ${SYMBOL_COLUMNS}
          ${scope} AND b.keywords @@ (${live[0]!.query}) AND NOT ${contains} AND NOT (b.keywords @@ (${keyword.match}))
          ORDER BY ${ladderRank(sql`b.keywords`, live)} DESC,
            ${keyword.whole ? sql`b.keywords @@ (${keyword.whole}) DESC,` : sql``} f.path COLLATE "C", b.start_line, b.id
          LIMIT ${CANDIDATES - rows.length}
        `)) as unknown as SymbolRow[])
  const found = [...rows, ...relaxed.map((r) => ({ ...r, relaxed: true as const }))]
  const strings = similarStrings(missing)
  if (found.length > 0 || strings.length === 0) return found
  const byName = similarity(strings, sql`b.inner_path`)
  const similar = (await db.execute(sql`
    SELECT ${SYMBOL_COLUMNS}
    ${scope} AND ${byName.matches}
    ORDER BY ${byName.best} DESC, f.path COLLATE "C", b.start_line, b.id
    LIMIT ${CANDIDATES}
  `)) as unknown as SymbolRow[]
  return similar.map((r) => ({ ...r, relaxed: true as const }))
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
  const rows =
    mode === 'keyword'
      ? await symbolKeywordRows(repositoryIds, query, filterSql)
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

/** A query token that is itself identifier- or file-shaped; plain words are not (#456). */
function isIdentifierShaped(token: string): boolean {
  return (
    token.includes('_') ||
    token.includes('::') ||
    /[\p{Ll}\p{N}]\p{Lu}/u.test(token) ||
    /[\p{L}\p{N}_]\.[\p{L}\p{N}_]/u.test(token) ||
    (token.includes('/') && /\.[A-Za-z0-9]{1,8}$/.test(token))
  )
}

interface ExactContext {
  /** The whole query, trimmed and lowercased, plus the same without surrounding punctuation. */
  whole: Set<string>
  /** Identifier- or file-shaped terms as typed, and lowercased. */
  terms: Set<string>
  termsLower: Set<string>
  /** Lowercased spellings (whole, joined, snake, kebab) of the identifier-shaped terms. */
  spelling: Set<string>
}

/**
 * What may count as an exact match (#456). A row is exact when its name, path
 * or title equals the WHOLE query, or equals a term that is itself an
 * identifier or file name. A plain word of a multi-word query never grants it:
 * one-word name hits must not outrank rows that match every word (#1014).
 */
function queryExactContext(query: string): ExactContext {
  const queryNorm = query.trim().toLowerCase()
  const queryStripped = queryNorm.replace(/^[^\p{L}\p{N}_$/.-]+|[^\p{L}\p{N}_$/.-]+$/gu, '').trim()
  const whole = new Set<string>([queryNorm])
  if (queryStripped.length > 0) whole.add(queryStripped)

  const terms = new Set<string>()
  const termsLower = new Set<string>()
  const spelling = new Set<string>()
  for (const raw of query.trim().split(/\s+/).filter(Boolean)) {
    const cleaned = raw.replace(/^[^\p{L}\p{N}_$/.-]+|[^\p{L}\p{N}_$/.-]+$/gu, '')
    if (cleaned.length <= 1 || !isIdentifierShaped(cleaned)) continue
    terms.add(cleaned)
    termsLower.add(cleaned.toLowerCase())
    const id = splitIdentifier(cleaned)
    for (const s of [id.whole, id.parts.join(''), id.parts.join('_'), id.parts.join('-')]) {
      if (s.length > 0) spelling.add(s.toLowerCase())
    }
  }
  return { whole, terms, termsLower, spelling }
}

/** A symbol whose name equals the whole query, or an identifier term by any of its spellings (#456). */
function isExactSymbol(name: string, parent: string | null | undefined, ctx: ExactContext): boolean {
  const lower = name.toLowerCase()
  if (lower.length <= 1) return false
  if (ctx.whole.has(lower) || ctx.terms.has(name) || ctx.spelling.has(lower)) return true
  if (parent) {
    const full = `${parent}.${name}`
    const fullLower = full.toLowerCase()
    if (ctx.whole.has(fullLower) || ctx.terms.has(full) || ctx.spelling.has(fullLower)) return true
  }
  return false
}

/** A file whose path or basename (with its extension) equals the whole query or a file-shaped term (#456). */
function isExactFile(path: string, ctx: ExactContext): boolean {
  const lower = path.toLowerCase()
  if (ctx.whole.has(lower) || ctx.termsLower.has(lower)) return true
  const baseLower = (path.split('/').pop() ?? path).toLowerCase()
  return ctx.whole.has(baseLower) || ctx.termsLower.has(baseLower)
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
  if (ctx.whole.has(path.trim().toLowerCase())) return true
  const title = noteTitle(frontmatter)
  return title !== '' && ctx.whole.has(title)
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
    rows.forEach((row, rank) => {
      const contribution = 1 / (RRF_K + rank + (row.relaxed ? CANDIDATES : 0) + 1)
      const existing = map.get(row.id)
      if (existing) {
        existing.score += contribution
        if (preferSnippet && row.snippet) existing.snippet = row.snippet
      } else {
        // A relaxed or trigram row never counts as exact: it did not match every word (#455 part 2).
        const exact = !row.relaxed && isExactSymbol(row.name, row.parent, ctx)
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
  const merged = new Map<string, SearchResult>()
  const contribute = (resourceType: ResourceType, rows: Row[], preferSnippet: boolean): void => {
    rows.forEach((row, rank) => {
      const key = `${resourceType}:${row.id}`
      const contribution = 1 / (RRF_K + rank + (row.relaxed ? CANDIDATES : 0) + 1)
      const existing = merged.get(key)
      if (existing) {
        existing.score += contribution
        if (preferSnippet) existing.snippet = row.snippet
      } else {
        const exact =
          !row.relaxed && (resourceType === 'note' ? isExactNote(row.path, row.frontmatter, ctx) : isExactFile(row.path, ctx))
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
          score: contribution + (exact ? EXACT_BOOST : 0),
        })
      }
    })
  }

  const contributeSymbols = (rows: SymbolRow[], preferSnippet: boolean): void => {
    rows.forEach((row, rank) => {
      const key = `symbol:${row.id}`
      const contribution = 1 / (RRF_K + rank + (row.relaxed ? CANDIDATES : 0) + 1)
      const existing = merged.get(key)
      if (existing) {
        existing.score += contribution
        if (preferSnippet && row.snippet) existing.snippet = row.snippet
      } else {
        const exact = !row.relaxed && isExactSymbol(row.name, row.parent, ctx)
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
          score: contribution + (exact ? EXACT_BOOST : 0),
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
