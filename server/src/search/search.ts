import { sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { embedder } from './embeddings.js'

function uuidArray(ids: string[]): SQL {
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]`
}

export interface SearchResult {
  noteId: string
  vaultId: string
  path: string
  frontmatter: unknown
  snippet: string
  score: number
}

const CANDIDATES = 30
const RRF_K = 60

/**
 * The one search function every caller uses (spec 4: human UI and MCP
 * share one path — results never diverge). Hybrid retrieval: Postgres
 * FTS + embedding KNN, merged by Reciprocal Rank Fusion. The permission
 * boundary is `vaultIds` — resolved live by the caller; the SQL never
 * touches anything outside it, so absence of access is absence from the
 * result set (no counts, no hints).
 */
export async function searchNotes(
  vaultIds: string[],
  query: string,
  limit = 20,
): Promise<SearchResult[]> {
  if (vaultIds.length === 0 || query.trim() === '') return []

  const keywordRows = (await db.execute(sql`
    SELECT id, vault_id, path, frontmatter,
           ts_headline('english', body, websearch_to_tsquery('english', ${query}),
                       'MaxWords=30, MinWords=10') AS snippet
    FROM notes
    WHERE vault_id = ANY(${uuidArray(vaultIds)})
      AND deleted_at IS NULL
      AND fts @@ websearch_to_tsquery('english', ${query})
    ORDER BY ts_rank(fts, websearch_to_tsquery('english', ${query})) DESC
    LIMIT ${CANDIDATES}
  `)) as unknown as Array<{
    id: string
    vault_id: string
    path: string
    frontmatter: unknown
    snippet: string
  }>

  const [queryVec] = await embedder.embed([query])
  const vec = JSON.stringify(queryVec)
  const semanticRows = (await db.execute(sql`
    SELECT id, vault_id, path, frontmatter, left(body, 200) AS snippet
    FROM notes
    WHERE vault_id = ANY(${uuidArray(vaultIds)})
      AND deleted_at IS NULL
      AND embedding IS NOT NULL
    ORDER BY embedding <=> ${vec}::vector
    LIMIT ${CANDIDATES}
  `)) as unknown as Array<{
    id: string
    vault_id: string
    path: string
    frontmatter: unknown
    snippet: string
  }>

  // Reciprocal Rank Fusion — rank-based, no score normalization to tune.
  const merged = new Map<string, SearchResult>()
  const contribute = (
    rows: typeof keywordRows,
    preferSnippet: boolean,
  ): void => {
    rows.forEach((row, rank) => {
      const existing = merged.get(row.id)
      const contribution = 1 / (RRF_K + rank + 1)
      if (existing) {
        existing.score += contribution
        if (preferSnippet) existing.snippet = row.snippet
      } else {
        merged.set(row.id, {
          noteId: row.id,
          vaultId: row.vault_id,
          path: row.path,
          frontmatter: row.frontmatter,
          snippet: row.snippet,
          score: contribution,
        })
      }
    })
  }
  contribute(semanticRows, false)
  contribute(keywordRows, true) // keyword snippets (highlighted) win

  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit)
}
