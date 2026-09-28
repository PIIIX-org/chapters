import { useQuery } from '@tanstack/react-query'
import { search } from '../api/search.js'
import type { ApiError } from '../lib/api.js'
import type { SearchResult } from '../api/search.js'
import type { GraphFilters } from '../api/graph.js'

export function useSearch(
  query: string,
  vaultId: string | null,
  filters: GraphFilters,
  opts?: { symbols?: boolean },
) {
  return useQuery<SearchResult[], ApiError>({
    queryKey: ['search', query, vaultId, filters, opts?.symbols],
    queryFn: () => search(query, { vaultId, filters, symbols: opts?.symbols }),
    enabled: query.trim().length > 0,
  })
}
