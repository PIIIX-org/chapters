import { useQuery } from '@tanstack/react-query'
import { getBacklinks, type Backlink } from '../api/notes.js'
import type { ApiError } from '../lib/api.js'

export function useBacklinks(vaultId: string, path: string) {
  return useQuery<Backlink[], ApiError>({
    queryKey: ['vaults', vaultId, 'backlinks', path],
    queryFn: () => getBacklinks(vaultId, path),
    enabled: Boolean(vaultId && path),
  })
}
