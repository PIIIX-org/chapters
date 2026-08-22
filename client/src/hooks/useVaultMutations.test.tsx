import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { mockJsonResponse } from '../lib/api'
import { VAULT_TRASH_QUERY_KEY, VAULTS_QUERY_KEY } from './useVaults'
import { useCreateVault, useDeleteVault, useRenameVault, useRestoreVault } from './useVaultMutations'

const vault = { id: 'v1', name: 'Engineering', ownerId: 'u1', mergeable: true, access: 'owner' as const }
const trashed = [{ id: 'v2', name: 'Old', deletedAt: '2026-08-01T00:00:00.000Z' }]

function makeClient() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(VAULTS_QUERY_KEY, [vault])
  queryClient.setQueryData(VAULT_TRASH_QUERY_KEY, trashed)
  return queryClient
}

function makeWrapper(queryClient: QueryClient) {
  return function wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

describe('useVaultMutations', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('useCreateVault invalidates vaults only', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, vault)))
    const queryClient = makeClient()

    const { result } = renderHook(() => useCreateVault(), { wrapper: makeWrapper(queryClient) })
    result.current.mutate('New')
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(queryClient.getQueryState(VAULTS_QUERY_KEY)!.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(VAULT_TRASH_QUERY_KEY)!.isInvalidated).toBe(false)
  })

  it('useRenameVault invalidates vaults but not trash', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, { ...vault, name: 'Renamed' })))
    const queryClient = makeClient()

    const { result } = renderHook(() => useRenameVault(), { wrapper: makeWrapper(queryClient) })
    result.current.mutate({ id: 'v1', name: 'Renamed' })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(queryClient.getQueryState(VAULTS_QUERY_KEY)!.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(VAULT_TRASH_QUERY_KEY)!.isInvalidated).toBe(false)
  })

  it('useDeleteVault invalidates both vaults and trash', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'trashed', id: 'v1' })))
    const queryClient = makeClient()

    const { result } = renderHook(() => useDeleteVault(), { wrapper: makeWrapper(queryClient) })
    result.current.mutate('v1')
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(queryClient.getQueryState(VAULTS_QUERY_KEY)!.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(VAULT_TRASH_QUERY_KEY)!.isInvalidated).toBe(true)
  })

  it('useRestoreVault invalidates both vaults and trash', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, vault)))
    const queryClient = makeClient()

    const { result } = renderHook(() => useRestoreVault(), { wrapper: makeWrapper(queryClient) })
    result.current.mutate('v2')
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(queryClient.getQueryState(VAULTS_QUERY_KEY)!.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(VAULT_TRASH_QUERY_KEY)!.isInvalidated).toBe(true)
  })
})
