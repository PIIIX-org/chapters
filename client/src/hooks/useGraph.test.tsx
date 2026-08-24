import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { renderHook, waitFor } from '@testing-library/react'
import { mockJsonResponse } from '../lib/api'
import type { GraphFilters } from '../api/graph.js'
import { useGraph } from './useGraph'

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/?vault=v1']}>{children}</MemoryRouter>
    </QueryClientProvider>
  )
}

describe('useGraph', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads the vault scope from the URL and fetches that vault graph', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, { nodes: [], edges: [], cappedGroups: [] }))
    vi.stubGlobal('fetch', fetchMock)

    renderHook(() => useGraph(null, {}), { wrapper })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const url = fetchMock.mock.calls[0]![0] as string
    expect(url).toContain('/api/vaults/v1/graph')
  })

  it('refetches when filters change', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, { nodes: [], edges: [], cappedGroups: [] }))
    vi.stubGlobal('fetch', fetchMock)

    const { rerender } = renderHook(({ filters }: { filters: GraphFilters }) => useGraph(null, filters), {
      wrapper,
      initialProps: { filters: {} },
    })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    rerender({ filters: { tags: ['a'] } })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const secondUrl = fetchMock.mock.calls[1]![0] as string
    expect(secondUrl).toContain('tags=a')
  })
})
