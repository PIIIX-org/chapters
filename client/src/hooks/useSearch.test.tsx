import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { mockJsonResponse } from '../lib/api'
import { useSearch } from './useSearch'

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

describe('useSearch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not fetch for an empty query', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    renderHook(() => useSearch('   '), { wrapper })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches results for a non-empty query', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(200, [{ resourceType: 'note', id: 'n1', containerId: 'v1', path: 'people/jane', snippet: 's', score: 1 }]),
      ),
    )
    const { result } = renderHook(() => useSearch('jane'), { wrapper })
    await waitFor(() => expect(result.current.data?.[0]?.path).toBe('people/jane'))
  })
})
