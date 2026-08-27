import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createRepository,
  createRepositoryShare,
  createSyncToken,
  createWebhookSecret,
  deleteRepository,
  getRepositoryFileContent,
  getRepositoryGraphPreference,
  listRepositories,
  listRepositoryFiles,
  listRepositoryShares,
  listSyncTokens,
  revokeRepositoryShare,
  revokeSyncToken,
  setRepositoryGraphPreference,
  updateRepository,
} from '../api/repositories.js'
import type {
  AccessibleRepository,
  CreateRepositoryInput,
  Repository,
  RepositoryFile,
  RepositoryFileContent,
  RepositoryShare,
  SyncToken,
  WebhookSecret,
} from '../api/repositories.js'
import type { ApiError } from '../lib/api.js'

export const REPOSITORIES_KEY = ['repositories'] as const
export const repositoryFilesKey = (id: string) => ['repositories', id, 'files'] as const
export const repositoryFileKey = (id: string, path: string) => ['repositories', id, 'file', path] as const
export const repositorySharesKey = (id: string) => ['repositories', id, 'shares'] as const
export const repositorySyncTokensKey = (id: string) => ['repositories', id, 'sync-tokens'] as const
export const repositoryGraphPreferenceKey = (id: string) =>
  ['repositories', id, 'graph-preference'] as const

export function useRepositories() {
  return useQuery<AccessibleRepository[], ApiError>({
    queryKey: REPOSITORIES_KEY,
    queryFn: listRepositories,
  })
}

/**
 * One repository, selected out of the list rather than fetched on its own —
 * there is no `GET /repositories/:id`, and adding one would duplicate a list
 * the shell already holds. `undefined` after a successful load means the
 * caller cannot reach that repository (or it is gone), which is the same
 * thing the server would say with a 404.
 */
export function useRepository(id: string) {
  return useQuery<AccessibleRepository[], ApiError, AccessibleRepository | undefined>({
    queryKey: REPOSITORIES_KEY,
    queryFn: listRepositories,
    select: (repos) => repos.find((r) => r.id === id),
  })
}

export function useRepositoryFiles(id: string) {
  return useQuery<RepositoryFile[], ApiError>({
    queryKey: repositoryFilesKey(id),
    queryFn: () => listRepositoryFiles(id),
  })
}

/**
 * File content plus its symbol outline. Disabled while no file is selected —
 * the viewer route renders a tree with no file chosen, and that is a real
 * state, not a request.
 */
export function useRepositoryFile(id: string, path: string | null) {
  return useQuery<RepositoryFileContent, ApiError>({
    queryKey: repositoryFileKey(id, path ?? ''),
    queryFn: () => getRepositoryFileContent(id, path!),
    enabled: path !== null && path !== '',
  })
}

export function useCreateRepository() {
  const queryClient = useQueryClient()
  return useMutation<Repository, ApiError, CreateRepositoryInput>({
    mutationFn: createRepository,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: REPOSITORIES_KEY, exact: true })
    },
  })
}

export function useUpdateRepository(id: string) {
  const queryClient = useQueryClient()
  return useMutation<Repository, ApiError, { name?: string; mergeable?: boolean }>({
    mutationFn: (patch) => updateRepository(id, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: REPOSITORIES_KEY, exact: true })
    },
  })
}

export function useDeleteRepository() {
  const queryClient = useQueryClient()
  return useMutation<{ status: 'deleted' }, ApiError, string>({
    mutationFn: deleteRepository,
    onSuccess: (_result, id) => {
      void queryClient.invalidateQueries({ queryKey: REPOSITORIES_KEY, exact: true })
      // The whole subtree goes with it — files, shares, tokens, preference.
      queryClient.removeQueries({ queryKey: ['repositories', id] })
    },
  })
}

export function useRepositoryShares(id: string) {
  return useQuery<RepositoryShare[], ApiError>({
    queryKey: repositorySharesKey(id),
    queryFn: () => listRepositoryShares(id),
  })
}

export function useCreateRepositoryShare(id: string) {
  const queryClient = useQueryClient()
  return useMutation<RepositoryShare, ApiError, { granteeType: 'user' | 'team'; granteeId: string }>({
    mutationFn: (body) => createRepositoryShare(id, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: repositorySharesKey(id) })
    },
  })
}

export function useRevokeRepositoryShare(id: string) {
  const queryClient = useQueryClient()
  return useMutation<{ status: 'revoked' }, ApiError, string>({
    mutationFn: (shareId) => revokeRepositoryShare(id, shareId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: repositorySharesKey(id) })
    },
  })
}

/**
 * The secret comes back once and lives only in this mutation's `data` until
 * `SecretReveal` is dismissed. Nothing caches it: no query key, no
 * invalidation target. The repository list still refreshes, because
 * `webhookConfigured` just changed.
 */
export function useCreateWebhookSecret(id: string) {
  const queryClient = useQueryClient()
  return useMutation<WebhookSecret, ApiError, void>({
    mutationFn: () => createWebhookSecret(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: REPOSITORIES_KEY, exact: true })
    },
  })
}

export function useSyncTokens(id: string) {
  return useQuery<SyncToken[], ApiError>({
    queryKey: repositorySyncTokensKey(id),
    queryFn: () => listSyncTokens(id),
  })
}

export function useCreateSyncToken(id: string) {
  const queryClient = useQueryClient()
  return useMutation<{ token: string }, ApiError, void>({
    mutationFn: () => createSyncToken(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: repositorySyncTokensKey(id) })
    },
  })
}

export function useRevokeSyncToken(id: string) {
  const queryClient = useQueryClient()
  return useMutation<{ status: 'revoked' }, ApiError, string>({
    mutationFn: (tokenId) => revokeSyncToken(id, tokenId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: repositorySyncTokensKey(id) })
    },
  })
}

/** Per-user "include this repository in my merged graph" — effective only if `mergeable`. */
export function useRepositoryGraphPreference(id: string) {
  return useQuery<{ include: boolean }, ApiError>({
    queryKey: repositoryGraphPreferenceKey(id),
    queryFn: () => getRepositoryGraphPreference(id),
  })
}

export function useSetRepositoryGraphPreference(id: string) {
  const queryClient = useQueryClient()
  return useMutation<{ include: boolean }, ApiError, boolean>({
    mutationFn: (include) => setRepositoryGraphPreference(id, include),
    onSuccess: (result) => {
      queryClient.setQueryData(repositoryGraphPreferenceKey(id), result)
    },
  })
}
