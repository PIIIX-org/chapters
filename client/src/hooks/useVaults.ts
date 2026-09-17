import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getVaultGraphPreference,
  listTrashedVaults,
  listVaults,
  setVaultGraphPreference,
} from '../api/vaults.js'
import type { ApiError } from '../lib/api.js'
import type { TrashedVault, Vault } from '../api/vaults.js'

export const VAULTS_QUERY_KEY = ['vaults'] as const
export const VAULT_TRASH_QUERY_KEY = ['vaults', 'trash'] as const

export function useVaults() {
  return useQuery<Vault[], ApiError>({
    queryKey: VAULTS_QUERY_KEY,
    queryFn: listVaults,
  })
}

export function useTrashedVaults() {
  return useQuery<TrashedVault[], ApiError>({
    queryKey: VAULT_TRASH_QUERY_KEY,
    queryFn: listTrashedVaults,
  })
}

export const vaultGraphPreferenceKey = (id: string) =>
  ['vaults', id, 'graph-preference'] as const

/** Per-user "include this vault in my merged graph" — effective only if `mergeable`. */
export function useVaultGraphPreference(id: string) {
  return useQuery<{ include: boolean }, ApiError>({
    queryKey: vaultGraphPreferenceKey(id),
    queryFn: () => getVaultGraphPreference(id),
  })
}

export function useSetVaultGraphPreference(id: string) {
  const queryClient = useQueryClient()
  return useMutation<{ include: boolean }, ApiError, boolean>({
    mutationFn: (include) => setVaultGraphPreference(id, include),
    onSuccess: (result) => {
      queryClient.setQueryData(vaultGraphPreferenceKey(id), result)
      queryClient.invalidateQueries({ queryKey: ['graph'] })
    },
  })
}
