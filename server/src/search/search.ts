import { sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { embedder } from './embeddings.js'
import { passesFilters, type GraphFilters } from '../graph/assemble.js'

function uuidArray(ids: string[]): SQL {
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]`
}

export type ResourceType = 'note' | 'code'

export interface SearchResourceSet {
  vaultIds: string[]
  repositoryIds: string[]
}

export interface SearchResult {
  resourceType: ResourceType
  id: string // noteId or repositoryFileId
  containerId: string // vaultId or repositoryId
  path: string
  type?: string | null // note OKF type, or code language
  frontmatter?: unknown // notes only
  language?: string | null // code only
  snippet: string
  score: number
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

async function noteRows(vaultIds: string[], query: string, mode: 'keyword' | 'semantic', vec?: string): Promise<Row[]> {
  if (vaultIds.length === 0) return []
  const rows =
    mode === 'keyword'
      ? await db.execute(sql`
          SELECT id, vault_id AS container_id, path, type, frontmatter,
                 ts_headline('english', body, websearch_to_tsquery('english', ${query}),
                             'MaxWords=30, MinWords=10') AS snippet
          FROM notes
          WHERE vault_id = ANY(${uuidArray(vaultIds)})
            AND deleted_at IS NULL
            AND fts @@ websearch_to_tsquery('english', ${query})
          ORDER BY ts_rank(fts, websearch_to_tsquery('english', ${query})) DESC
          LIMIT ${CANDIDATES}
        `)
      : await db.execute(sql`
          SELECT id, vault_id AS container_id, path, type, frontmatter, left(body, 200) AS snippet
          FROM notes
          WHERE vault_id = ANY(${uuidArray(vaultIds)})
            AND deleted_at IS NULL
            AND embedding IS NOT NULL
          ORDER BY embedding <=> ${vec}::vector
          LIMIT ${CANDIDATES}
        `)
  return rows as unknown as Row[]
}

async function codeRows(repositoryIds: string[], query: string, mode: 'keyword' | 'semantic', vec?: string): Promise<Row[]> {
  if (repositoryIds.length === 0) return []
  const rows =
    mode === 'keyword'
      ? await db.execute(sql`
          SELECT id, repository_id AS container_id, path, language,
                 ts_headline('english', content, websearch_to_tsquery('english', ${query}),
                             'MaxWords=30, MinWords=10') AS snippet
          FROM repository_files
          WHERE repository_id = ANY(${uuidArray(repositoryIds)})
            AND fts @@ websearch_to_tsquery('english', ${query})
          ORDER BY ts_rank(fts, websearch_to_tsquery('english', ${query})) DESC
          LIMIT ${CANDIDATES}
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

/**
 * The one search function every caller uses (spec 4/9: human UI and MCP
 * share one path across both notes and code — results never diverge).
 * Hybrid retrieval: Postgres FTS + embedding KNN, merged by Reciprocal
 * Rank Fusion. The permission boundary is `resources` — resolved live by
 * the caller; the SQL never touches anything outside it, so absence of
 * access is absence from the result set (no counts, no hints).
 */
export async function searchNotes(
  resources: SearchResourceSet,
  query: string,
  limit = 20,
  filters: GraphFilters = {},
): Promise<SearchResult[]> {
  const { vaultIds, repositoryIds } = resources
  if ((vaultIds.length === 0 && repositoryIds.length === 0) || query.trim() === '') return []

  const [queryVec] = await embedder.embed([query])
  const vec = JSON.stringify(queryVec)

  const [noteKeyword, noteSemantic, codeKeyword, codeSemantic] = await Promise.all([
    noteRows(vaultIds, query, 'keyword'),
    noteRows(vaultIds, query, 'semantic', vec),
    codeRows(repositoryIds, query, 'keyword'),
    codeRows(repositoryIds, query, 'semantic', vec),
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
  contribute('note', noteSemantic, false)
  contribute('code', codeSemantic, false)
  contribute('note', noteKeyword, true) // keyword snippets (highlighted) win
  contribute('code', codeKeyword, true)

  // ponytail: filtering runs after the 30-row-per-query candidate fetch, so a
  // narrow filter can return fewer than `limit` rows even when more would
  // match. Push predicates into SQL instead if recall complains.
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
