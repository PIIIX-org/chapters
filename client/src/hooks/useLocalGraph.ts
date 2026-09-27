import { useQuery } from '@tanstack/react-query'
import { fetchLocalGraph, type LocalGraphData } from '../api/graph.js'
import type { ApiError } from '../lib/api.js'

export function useLocalGraph(vaultId: string, path: string, depth = 1) {
  return useQuery<LocalGraphData, ApiError>({
    queryKey: ['vaults', vaultId, 'local-graph', path, depth],
    queryFn: () => fetchLocalGraph(vaultId, path, depth),
    enabled: Boolean(vaultId && path),
  })
}
