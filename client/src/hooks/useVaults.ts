import { useQuery } from '@tanstack/react-query'
import { listVaults } from '../api/vaults.js'
import type { ApiError } from '../lib/api.js'
import type { Vault } from '../api/vaults.js'

export const VAULTS_QUERY_KEY = ['vaults'] as const

export function useVaults() {
  return useQuery<Vault[], ApiError>({
    queryKey: VAULTS_QUERY_KEY,
    queryFn: listVaults,
  })
}
