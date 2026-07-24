import { useQuery } from '@tanstack/react-query'
import { getVaultTree } from '../api/notes.js'
import type { ApiError } from '../lib/api.js'
import type { VaultTree } from '../api/notes.js'

export function useVaultTree(vaultId: string) {
  return useQuery<VaultTree, ApiError>({
    queryKey: ['vault-tree', vaultId],
    queryFn: () => getVaultTree(vaultId),
  })
}
