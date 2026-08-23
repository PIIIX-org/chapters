import { apiFetch } from '../lib/api.js'
import type { GraphFilters } from '../api/graph.js'

export interface SearchResult {
  resourceType: 'note' | 'code'
  id: string
  containerId: string
  path: string
  type?: string | null
  frontmatter?: Record<string, unknown>
  language?: string | null
  snippet: string
  score: number
}

export function search(
  query: string,
  opts?: { limit?: number; vaultId?: string | null; filters?: GraphFilters },
): Promise<SearchResult[]> {
  const path = opts?.vaultId ? `/vaults/${opts.vaultId}/search` : '/search'
  const filters = opts?.filters

  const parts = [`q=${encodeURIComponent(query)}`, `limit=${opts?.limit ?? 20}`]
  if (filters?.types?.length) parts.push(`types=${filters.types.join(',')}`)
  if (filters?.tags?.length) parts.push(`tags=${filters.tags.join(',')}`)
  if (filters?.since) parts.push(`since=${filters.since}`)
  if (filters?.until) parts.push(`until=${filters.until}`)

  return apiFetch(`${path}?${parts.join('&')}`)
}
