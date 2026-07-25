import { useQuery } from '@tanstack/react-query'
import { search } from '../api/search.js'
import type { ApiError } from '../lib/api.js'
import type { SearchResult } from '../api/search.js'

export function useSearch(query: string) {
  return useQuery<SearchResult[], ApiError>({
    queryKey: ['search', query],
    queryFn: () => search(query),
    enabled: query.trim().length > 0,
  })
}
