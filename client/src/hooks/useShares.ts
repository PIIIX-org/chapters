import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createShare,
  listShares,
  listTeams,
  lookupUserByEmail,
  revokeShare,
} from '../api/shares.js'
import type { GranteeType, Share, SharePermission, Team } from '../api/shares.js'
import type { ApiError } from '../lib/api.js'

export const sharesQueryKey = (vaultId: string) => ['shares', vaultId] as const
export const TEAMS_QUERY_KEY = ['teams'] as const

// `enabled` defaults true for SharingPanel's always-on fetch; VaultReachExpansion
// passes its disclosure's open state so an owner with many vaults doesn't fire a
// shares request for every one of them on page load.
export function useShares(vaultId: string, enabled = true) {
  return useQuery<Share[], ApiError>({
    queryKey: sharesQueryKey(vaultId),
    queryFn: () => listShares(vaultId),
    enabled,
  })
}

export function useTeams() {
  return useQuery<Team[], ApiError>({
    queryKey: TEAMS_QUERY_KEY,
    queryFn: () => listTeams(),
  })
}

export function useCreateShare(vaultId: string) {
  const queryClient = useQueryClient()
  return useMutation<Share, ApiError, { granteeType: GranteeType; granteeId: string; permission: SharePermission }>({
    mutationFn: (body) => createShare(vaultId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sharesQueryKey(vaultId), exact: true })
    },
  })
}

export function useRevokeShare(vaultId: string) {
  const queryClient = useQueryClient()
  return useMutation<{ status: 'revoked' }, ApiError, string>({
    mutationFn: (shareId) => revokeShare(vaultId, shareId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sharesQueryKey(vaultId), exact: true })
    },
  })
}

/** Not a query — a one-shot lookup fired from the add-by-email form's submit. */
export function useLookupUser() {
  return useMutation<{ id: string; email: string }, ApiError, string>({
    mutationFn: (email) => lookupUserByEmail(email),
  })
}
