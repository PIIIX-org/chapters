import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { mockJsonResponse } from '../lib/api'
import { useDeleteNote } from './useDeleteNote'

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

describe('useDeleteNote', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('deletes a note and resolves trashed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'trashed', id: 'n1' })))

    const { result } = renderHook(() => useDeleteNote('v1'), { wrapper })
    result.current.mutate('people/jane')

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.status).toBe('trashed')
  })
})
