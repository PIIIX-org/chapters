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
      : await db.execute(sql`
          SELECT id, repository_id AS container_id, path, language, left(content, 200) AS snippet
          FROM repository_files
          WHERE repository_id = ANY(${uuidArray(repositoryIds)})
            AND embedding IS NOT NULL
          ORDER BY embedding <=> ${vec}::vector
          LIMIT ${CANDIDATES}
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
  const rows =
    mode === 'keyword'
      ? await db.execute(sql`
          SELECT s.id, s.file_id, f.repository_id AS container_id, f.path,
                 s.name, s.kind, s.start_line, s.end_line,
                 coalesce(s.snippet, s.name) AS snippet
          FROM repository_file_symbols s
          JOIN repository_files f ON f.id = s.file_id
          WHERE f.repository_id = ANY(${uuidArray(repositoryIds)})
            ${kindFilter ? sql`AND s.kind = ${kindFilter}` : sql``}
            AND (
              s.name ILIKE ${`%${query}%`}
              OR (s.snippet IS NOT NULL AND s.snippet ILIKE ${`%${query}%`})
            )
          ORDER BY
            CASE
              WHEN lower(s.name) = lower(${query}) THEN 1
              WHEN lower(s.name) LIKE lower(${`${query}%`}) THEN 2
              ELSE 3
            END
          LIMIT ${CANDIDATES}
        `)
      : await db.execute(sql`
          SELECT s.id, s.file_id, f.repository_id AS container_id, f.path,
                 s.name, s.kind, s.start_line, s.end_line,
                 coalesce(s.snippet, s.name) AS snippet
          FROM repository_file_symbols s
          JOIN repository_files f ON f.id = s.file_id
          WHERE f.repository_id = ANY(${uuidArray(repositoryIds)})
            ${kindFilter ? sql`AND s.kind = ${kindFilter}` : sql``}
            AND s.embedding IS NOT NULL
          ORDER BY s.embedding <=> ${vec}::vector
          LIMIT ${CANDIDATES}
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

  return [...map.values()].sort((a, b) => b.score - a.score).slice(0, limit)
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
