import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { mockJsonResponse } from '../lib/api'
import { useSession } from './useSession'

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

describe('useSession', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves the current session on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(200, { id: 'u1', email: 'a@b.com', status: 'active', role: 'member', createdAt: '2026-01-01' }),
      ),
    )

    const { result } = renderHook(() => useSession(), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.email).toBe('a@b.com')
  })

  it('is an error when there is no session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(401, { error: 'unauthorized' })))

    const { result } = renderHook(() => useSession(), { wrapper })

    await waitFor(() => expect(result.current.isError).toBe(true))
  })
})
