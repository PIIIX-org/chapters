import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { listTrashedNotes, restoreNote } from '../api/notes.js'
import type { TrashedNote } from '../api/notes.js'
import { purgeVault } from '../api/vaults.js'
import { VAULT_TRASH_QUERY_KEY, VAULTS_QUERY_KEY } from './useVaults.js'
import type { ApiError } from '../lib/api.js'

export const trashedNotesQueryKey = (vaultId: string) => ['vaults', vaultId, 'trash'] as const

export function useTrashedNotes(vaultId: string) {
  return useQuery<TrashedNote[], ApiError>({
    queryKey: trashedNotesQueryKey(vaultId),
    queryFn: () => listTrashedNotes(vaultId),
    enabled: vaultId !== '',
  })
}

/** A restored note reappears in the tree, so that has to be refetched too. */
export function useRestoreNote(vaultId: string) {
  const queryClient = useQueryClient()
  return useMutation<{ id: string; path: string }, ApiError, string>({
    mutationFn: (noteId) => restoreNote(vaultId, noteId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: trashedNotesQueryKey(vaultId) })
      void queryClient.invalidateQueries({ queryKey: ['vaults', vaultId, 'tree'] })
    },
  })
}

/** Purging a trashed vault removes it from the trash list, not the live one. */
export function usePurgeVault() {
  const queryClient = useQueryClient()
  return useMutation<{ status: 'purged' }, ApiError, string>({
    mutationFn: purgeVault,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: VAULT_TRASH_QUERY_KEY })
      void queryClient.invalidateQueries({ queryKey: VAULTS_QUERY_KEY })
    },
  })
}
