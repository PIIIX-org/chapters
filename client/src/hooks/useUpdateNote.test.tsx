import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { mockJsonResponse } from '../lib/api'
import { useUpdateNote } from './useUpdateNote'

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

describe('useUpdateNote', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('saves the note and resolves with the updated result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(200, {
          id: 'n1',
          path: 'people/jane',
          frontmatter: { type: 'people' },
          body: 'New body.',
          updatedAt: '2026-01-02',
        }),
      ),
    )

    const { result } = renderHook(() => useUpdateNote('v1', 'people/jane'), { wrapper })
    result.current.mutate({ body: 'New body.' })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.body).toBe('New body.')
  })
})
