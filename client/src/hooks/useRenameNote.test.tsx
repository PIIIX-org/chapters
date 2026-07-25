import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { mockJsonResponse } from '../lib/api'
import { useRenameNote } from './useRenameNote'

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

describe('useRenameNote', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renames a note and resolves with the new path', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(200, { id: 'n1', path: 'people/jane-doe', type: 'people', name: 'jane-doe', frontmatter: {}, body: '', updatedAt: '2026-01-02' }),
      ),
    )

    const { result } = renderHook(() => useRenameNote('v1'), { wrapper })
    result.current.mutate({ from: 'people/jane', to: 'jane-doe' })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.path).toBe('people/jane-doe')
  })
})
