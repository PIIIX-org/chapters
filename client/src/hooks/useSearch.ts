import { useQuery } from '@tanstack/react-query'
import { search } from '../api/search.js'
import type { ApiError } from '../lib/api.js'
import type { SearchResult } from '../api/search.js'
import type { GraphFilters } from '../api/graph.js'

export function useSearch(query: string, vaultId: string | null, filters: GraphFilters) {
  return useQuery<SearchResult[], ApiError>({
    queryKey: ['search', query, vaultId, filters],
    queryFn: () => search(query, { vaultId, filters }),
    enabled: query.trim().length > 0,
  })
}
