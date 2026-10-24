import { sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { embedder } from './embeddings.js'
import { passesFilters, type GraphFilters } from '../graph/assemble.js'

function uuidArray(ids: string[]): SQL {
  // ponytail: single Postgres array parameter literal instead of N placeholders (DB-07).
  return sql`${`{${ids.join(',')}}`}::uuid[]`
}

function noteFilterClauses(filters?: GraphFilters): SQL {
  const clauses: SQL[] = []
  if (filters?.types && filters.types.length > 0) {
    clauses.push(sql`AND type = ANY(${`{${filters.types.join(',')}}`}::text[])`)
  }
  if (filters?.since) {
    clauses.push(sql`AND (frontmatter->>'timestamp') >= ${filters.since}`)
  }
  if (filters?.until) {
    clauses.push(sql`AND (frontmatter->>'timestamp') <= ${filters.until}`)
  }
  return clauses.length > 0 ? sql.join(clauses, sql` `) : sql``
}

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

const CANDIDATES = 30
const RRF_K = 60
/**
 * Nearest blocks a code vector leg reads before it keeps each file's best
 * one (#452): a file has several blocks, so 30 files need more than 30.
 * Also the leg's `hnsw.ef_search`, since HNSW returns at most that many rows.
 */
const BLOCK_CANDIDATES = 200

/** A vector leg over `blocks`, its HNSW search widened to `BLOCK_CANDIDATES` (the default 40 would cap it). */
async function blockLeg(query: SQL): Promise<unknown> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL hnsw.ef_search = ${BLOCK_CANDIDATES}`))
    return tx.execute(query)
  })
}

/** A symbol block `b`'s bare name: `inner_path` without its `symbol_parent.` prefix. */
const SYMBOL_NAME = sql.raw(`CASE WHEN b.symbol_parent IS NULL THEN b.inner_path ELSE substr(b.inner_path, length(b.symbol_parent) + 2) END`)

/** The columns of a symbol hit from block `b` of file `f`; the snippet is the one code-blocks.ts stored and embedded. */
const SYMBOL_COLUMNS = sql`b.id, b.owner_id AS file_id, b.container_id, f.path, ${SYMBOL_NAME} AS name,
  b.symbol_kind AS kind, b.symbol_parent AS parent, b.start_line, b.end_line, coalesce(b.snippet, ${SYMBOL_NAME}) AS snippet`

interface Row {
  id: string
  container_id: string
  path: string
  type?: string | null
  frontmatter?: unknown
  language?: string | null
  snippet: string
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
            SELECT id, vault_id AS container_id, path, type, frontmatter, body
            FROM notes
            WHERE vault_id = ANY(${uuidArray(vaultIds)})
              AND deleted_at IS NULL
              AND fts @@ websearch_to_tsquery('english', ${query})
              ${filterSql}
            ORDER BY ts_rank(fts, websearch_to_tsquery('english', ${query})) DESC
            LIMIT ${CANDIDATES}
          )
          SELECT id, container_id, path, type, frontmatter,
                 ts_headline('english', body, websearch_to_tsquery('english', ${query}),
                             'MaxWords=30, MinWords=10') AS snippet
          FROM top_notes
        `)
      : await db.execute(sql`
          SELECT id, vault_id AS container_id, path, type, frontmatter, left(body, 200) AS snippet
          FROM notes
          WHERE vault_id = ANY(${uuidArray(vaultIds)})
            AND deleted_at IS NULL
            AND embedding IS NOT NULL
            ${filterSql}
          ORDER BY embedding <=> ${vec}::vector
          LIMIT ${CANDIDATES}
        `)
  return rows as unknown as Row[]
}

async function codeRows(repositoryIds: string[], query: string, mode: 'keyword' | 'semantic', vec?: string): Promise<Row[]> {
  if (repositoryIds.length === 0) return []
  // ponytail: CTE wraps candidate search so ts_headline only runs on top 30 files (DB-12).
  const rows =
    mode === 'keyword'
      ? await db.execute(sql`
          WITH top_code AS (
            SELECT id, repository_id AS container_id, path, language, content
            FROM repository_files
            WHERE repository_id = ANY(${uuidArray(repositoryIds)})
              AND fts @@ websearch_to_tsquery('english', ${query})
            ORDER BY ts_rank(fts, websearch_to_tsquery('english', ${query})) DESC
            LIMIT ${CANDIDATES}
          )
          SELECT id, container_id, path, language,
                 ts_headline('english', content, websearch_to_tsquery('english', ${query}),
                             'MaxWords=30, MinWords=10') AS snippet
          FROM top_code
        `)
      : await blockLeg(sql`
          -- A file's vector rank is its best block's distance (ADR-004 §2.5 roll-up): one row per file, as before blocks.
          WITH nearest AS (
            SELECT owner_id, embedding <=> ${vec}::vector AS distance
            FROM blocks
            WHERE owner_type = 'code' AND container_id = ANY(${uuidArray(repositoryIds)}) AND embedding IS NOT NULL
            ORDER BY embedding <=> ${vec}::vector
            LIMIT ${BLOCK_CANDIDATES}
          ), best AS (
            SELECT owner_id, min(distance) AS distance FROM nearest GROUP BY owner_id ORDER BY 2, 1 LIMIT ${CANDIDATES}
          )
          SELECT f.id, f.repository_id AS container_id, f.path, f.language, left(f.content, 200) AS snippet
          FROM best JOIN repository_files f ON f.id = best.owner_id
          ORDER BY best.distance, f.id
        `)
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
  const repos = uuidArray(repositoryIds)
  const kind = kindFilter ? sql`AND b.symbol_kind = ${kindFilter}` : sql``
  const pattern = `%${query}%`
  const rows =
    mode === 'keyword'
      ? await db.execute(sql`
          -- By name, by Class.name (inner_path), or by snippet, as the symbol table was matched before blocks.
          SELECT ${SYMBOL_COLUMNS}
          FROM blocks b JOIN repository_files f ON f.id = b.owner_id
          WHERE b.owner_type = 'code' AND b.kind = 'symbol' AND b.container_id = ANY(${repos}) ${kind}
            AND (b.inner_path ILIKE ${pattern} OR (b.snippet IS NOT NULL AND b.snippet ILIKE ${pattern}))
          ORDER BY
            CASE
              WHEN lower(${SYMBOL_NAME}) = lower(${query}) OR lower(b.inner_path) = lower(${query}) THEN 1
              WHEN lower(${SYMBOL_NAME}) LIKE lower(${`${query}%`}) THEN 2
              ELSE 3
            END
          LIMIT ${CANDIDATES}
        `)
      : await blockLeg(sql`
          WITH nearest AS (
            SELECT b.id, b.embedding <=> ${vec}::vector AS distance FROM blocks b
            WHERE b.owner_type = 'code' AND b.kind = 'symbol' AND b.container_id = ANY(${repos}) ${kind}
              AND b.embedding IS NOT NULL
            ORDER BY b.embedding <=> ${vec}::vector
            LIMIT ${CANDIDATES}
          )
          SELECT ${SYMBOL_COLUMNS}
          FROM nearest JOIN blocks b ON b.id = nearest.id JOIN repository_files f ON f.id = b.owner_id
          ORDER BY nearest.distance
        `)
  return rows as unknown as SymbolRow[]
}

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
): Promise<SymbolSearchResult[]> {
  if (repositoryIds.length === 0 || query.trim() === '') return []
  const limit = options?.limit ?? 20
  const kind = options?.kind

  const [queryVec] = await embedder.embed([query])
  const vec = JSON.stringify(queryVec)

  const [kw, sem] = await Promise.all([
    symbolRows(repositoryIds, query, 'keyword', undefined, kind),
    symbolRows(repositoryIds, query, 'semantic', vec, kind),
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

  contribute(sem, false)
  contribute(kw, true)

  // Equal scores in id order, so the MCP cursor's next page (#422) continues the same ranking.
  return [...map.values()].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, limit)
}

/**
 * The one search function every caller uses (spec 4/9: human UI and MCP
 * share one path across both notes and code — results never diverge).
 * Hybrid retrieval: Postgres FTS + embedding KNN, merged by Reciprocal
 * Rank Fusion.
 */
export async function searchNotes(
  resources: SearchResourceSet,
  query: string,
  limit = 20,
  filters: GraphFilters = {},
  options: SearchNotesOptions = {},
): Promise<SearchResult[]> {
  const { vaultIds, repositoryIds } = resources
  if ((vaultIds.length === 0 && repositoryIds.length === 0) || query.trim() === '') return []

  const [queryVec] = await embedder.embed([query])
  const vec = JSON.stringify(queryVec)

  const includeSymbols = options.includeSymbols ?? false

  const [noteKeyword, noteSemantic, codeKeyword, codeSemantic, symKeyword, symSemantic] = await Promise.all([
    noteRows(vaultIds, query, 'keyword', undefined, filters),
    noteRows(vaultIds, query, 'semantic', vec, filters),
    codeRows(repositoryIds, query, 'keyword'),
    codeRows(repositoryIds, query, 'semantic', vec),
    includeSymbols ? symbolRows(repositoryIds, query, 'keyword') : Promise.resolve([]),
    includeSymbols ? symbolRows(repositoryIds, query, 'semantic', vec) : Promise.resolve([]),
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
          snippet: row.snippet,
          score: contribution,
        })
      }
    })
  }

  contribute('note', noteSemantic, false)
  contribute('code', codeSemantic, false)
  contribute('note', noteKeyword, true)
  contribute('code', codeKeyword, true)

  if (includeSymbols) {
    contributeSymbols(symSemantic, false)
    contributeSymbols(symKeyword, true)
  }

  const filtered = [...merged.values()].filter((r) => {
    const fm = (r.frontmatter ?? {}) as { tags?: unknown; timestamp?: unknown }
    return passesFilters(
      {
        type: r.type ?? null,
        tags: Array.isArray(fm.tags) ? (fm.tags as string[]) : [],
        timestamp: typeof fm.timestamp === 'string' ? fm.timestamp : null,
      },
      filters,
    )
  })

  return filtered.sort((a, b) => b.score - a.score).slice(0, limit)
}
