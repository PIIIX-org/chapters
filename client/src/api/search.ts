import { apiFetch } from '../lib/api.js'
import type { GraphFilters } from '../api/graph.js'

export interface SearchResult {
  resourceType: 'note' | 'code' | 'symbol'
  id: string
  containerId: string
  path: string
  type?: string | null
  frontmatter?: Record<string, unknown>
  language?: string | null
  symbolName?: string
  symbolKind?: string
  startLine?: number
  endLine?: number
  snippet: string
  score: number
}

/**
 * Every search answers this (#441, #442, #458): `status` says whether an
 * empty `results` means nothing matched (`no_match`), the scope is still
 * being indexed (`index_building`) or search could not run (`unavailable`);
 * `degraded` says a channel was missing (keyword hits only when the query
 * could not be embedded). `index` is left out when nothing is pending or failed.
 */
export interface SearchResponse {
  status: 'ok' | 'no_match' | 'index_building' | 'unavailable'
  retrieval_mode: 'hybrid' | 'keyword_only' | 'vector_only' | 'none'
  degraded: false | { reason: 'embedder_failed' | 'vector_leg_failed' | 'keyword_leg_failed' }
  index?: { pending_notes: number; pending_files: number; pending_repositories: number; failed: number }
  results: SearchResult[]
}

export function search(
  query: string,
  opts?: { limit?: number; vaultId?: string | null; filters?: GraphFilters; symbols?: boolean },
): Promise<SearchResponse> {
  const path = opts?.vaultId ? `/vaults/${opts.vaultId}/search` : '/search'
  const filters = opts?.filters

  const parts = [`q=${encodeURIComponent(query)}`, `limit=${opts?.limit ?? 20}`]
  if (opts?.symbols) parts.push('symbols=true')
  if (filters?.types?.length) parts.push(`types=${filters.types.join(',')}`)
  if (filters?.tags?.length) parts.push(`tags=${filters.tags.join(',')}`)
  if (filters?.since) parts.push(`since=${filters.since}`)
  if (filters?.until) parts.push(`until=${filters.until}`)

  return apiFetch(`${path}?${parts.join('&')}`)
}
