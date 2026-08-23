import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router'
import { fetchGraph } from '../api/graph.js'
import type { CommunityGraph, GraphFilters, VaultGraph } from '../api/graph.js'
import type { ApiError } from '../lib/api.js'

export function useGraph(community: number | null, filters: GraphFilters) {
  const [searchParams] = useSearchParams()
  const vaultId = searchParams.get('vault')

  return useQuery<VaultGraph | CommunityGraph, ApiError>({
    queryKey: ['graph', vaultId, community, filters],
    queryFn: () => fetchGraph({ vaultId, community, filters }),
  })
}
