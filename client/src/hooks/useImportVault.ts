import { useMutation, useQueryClient } from '@tanstack/react-query'
import { importVault } from '../api/import.js'
import type { ImportResult } from '../api/import.js'
import { VAULTS_QUERY_KEY } from './useVaults.js'
import type { ApiError } from '../lib/api.js'

/** Always produces a NEW vault the caller owns, so the vault list is stale. */
export function useImportVault() {
  const queryClient = useQueryClient()
  return useMutation<ImportResult, ApiError, File>({
    mutationFn: importVault,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: VAULTS_QUERY_KEY })
    },
  })
}
