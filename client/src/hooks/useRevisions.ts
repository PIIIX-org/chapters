import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { listRevisions, purgeRevision, revertNote } from '../api/revisions.js'
import type { Revision } from '../api/revisions.js'
import type { ApiError } from '../lib/api.js'

export const revisionsQueryKey = (vaultId: string, path: string, offset: number) =>
  ['vaults', vaultId, 'history', path, offset] as const

export function useRevisions(vaultId: string, path: string, limit: number, offset: number) {
  return useQuery<Revision[], ApiError>({
    queryKey: revisionsQueryKey(vaultId, path, offset),
    queryFn: () => listRevisions(vaultId, path, limit, offset),
    enabled: vaultId !== '' && path !== '',
  })
}

/**
 * A revert is a new write, so it both changes the note and adds a revision —
 * the note query and every page of the history are stale afterwards.
 */
export function useRevertNote(vaultId: string, path: string) {
  const queryClient = useQueryClient()
  return useMutation<{ id: string; path: string }, ApiError, string>({
    mutationFn: (revisionId) => revertNote(vaultId, path, revisionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['vaults', vaultId, 'history', path] })
      void queryClient.invalidateQueries({ queryKey: ['vaults', vaultId, 'notes', path] })
    },
  })
}

export function usePurgeRevision(vaultId: string, path: string) {
  const queryClient = useQueryClient()
  return useMutation<{ status: 'purged' }, ApiError, string>({
    mutationFn: (revisionId) => purgeRevision(vaultId, revisionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['vaults', vaultId, 'history', path] })
    },
  })
}
