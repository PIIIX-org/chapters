import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { mockJsonResponse } from '../lib/api'
import { useCreateNote } from './useCreateNote'

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

describe('useCreateNote', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('creates a note and resolves with the result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(201, { id: 'n1', path: 'people/jane', type: 'people', name: 'jane', frontmatter: {}, body: '', updatedAt: '2026-01-01' }),
      ),
    )

    const { result } = renderHook(() => useCreateNote('v1'), { wrapper })
    result.current.mutate({ type: 'people', name: 'jane' })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.path).toBe('people/jane')
  })
})
