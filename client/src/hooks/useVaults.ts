import { useQuery } from '@tanstack/react-query'
import { listTrashedVaults, listVaults } from '../api/vaults.js'
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
