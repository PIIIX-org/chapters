import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createVault, deleteVault, renameVault, restoreVault } from '../api/vaults.js'
import { VAULT_TRASH_QUERY_KEY, VAULTS_QUERY_KEY } from './useVaults.js'
import type { ApiError } from '../lib/api.js'
import type { Vault } from '../api/vaults.js'

export function useCreateVault() {
  const queryClient = useQueryClient()
  return useMutation<Vault, ApiError, string>({
    mutationFn: (name) => createVault(name),
    onSuccess: () => {
      // exact: true — VAULT_TRASH_QUERY_KEY is prefixed by VAULTS_QUERY_KEY, and a
      // non-exact invalidate would cascade into it. Only the vaults list moved.
      void queryClient.invalidateQueries({ queryKey: VAULTS_QUERY_KEY, exact: true })
    },
  })
}

export function useRenameVault() {
  const queryClient = useQueryClient()
  return useMutation<Vault, ApiError, { id: string; name: string }>({
    mutationFn: ({ id, name }) => renameVault(id, name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: VAULTS_QUERY_KEY, exact: true })
    },
  })
}

export function useDeleteVault() {
  const queryClient = useQueryClient()
  return useMutation<{ status: 'trashed'; id: string }, ApiError, string>({
    mutationFn: (id) => deleteVault(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: VAULTS_QUERY_KEY })
      void queryClient.invalidateQueries({ queryKey: VAULT_TRASH_QUERY_KEY })
    },
  })
}

export function useRestoreVault() {
  const queryClient = useQueryClient()
  return useMutation<Vault, ApiError, string>({
    mutationFn: (id) => restoreVault(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: VAULTS_QUERY_KEY })
      void queryClient.invalidateQueries({ queryKey: VAULT_TRASH_QUERY_KEY })
    },
  })
}
