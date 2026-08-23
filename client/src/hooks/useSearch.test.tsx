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
    renderHook(() => useSearch('   ', null, {}), { wrapper })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches results for a non-empty query and carries frontmatter/language through', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(200, [
          {
            resourceType: 'note',
            id: 'n1',
            containerId: 'v1',
            path: 'people/jane',
            snippet: 's',
            score: 1,
            frontmatter: { title: 'Jane' },
            language: null,
          },
        ]),
      ),
    )
    const { result } = renderHook(() => useSearch('jane', null, {}), { wrapper })
    await waitFor(() => expect(result.current.data?.[0]?.path).toBe('people/jane'))
    expect(result.current.data?.[0]?.frontmatter).toEqual({ title: 'Jane' })
    expect(result.current.data?.[0]?.language).toBe(null)
  })

  it('refetches with a new URL when vaultId changes, instead of serving a stale cached result', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        mockJsonResponse(200, [
          { resourceType: 'note', id: 'n1', containerId: 'v1', path: 'everywhere/hit', snippet: 's', score: 1 },
        ]),
      )
      .mockResolvedValueOnce(
        mockJsonResponse(200, [
          { resourceType: 'note', id: 'n2', containerId: 'v2', path: 'v2/hit', snippet: 's', score: 1 },
        ]),
      )
    vi.stubGlobal('fetch', fetchMock)

    const { result, rerender } = renderHook(({ vaultId }: { vaultId: string | null }) => useSearch('jane', vaultId, {}), {
      wrapper,
      initialProps: { vaultId: null as string | null },
    })
    await waitFor(() => expect(result.current.data?.[0]?.path).toBe('everywhere/hit'))

    rerender({ vaultId: 'v2' })
    await waitFor(() => expect(result.current.data?.[0]?.path).toBe('v2/hit'))

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const urls = fetchMock.mock.calls.map((call) => call[0] as string)
    expect(urls[0]).toBe('/api/search?q=jane&limit=20')
    expect(urls[1]).toBe('/api/vaults/v2/search?q=jane&limit=20')
    expect(new Set(urls).size).toBe(2)
  })
})
