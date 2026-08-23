import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { mockJsonResponse } from '../lib/api'
import { useMarkNotificationRead, useNotifications } from './useNotifications'

const notification = {
  id: 'n1',
  recipientId: 'u1',
  type: 'mention',
  entityType: 'note',
  entityId: 'note1',
  message: 'you were mentioned',
  readAt: null,
  createdAt: '2026-08-01T00:00:00.000Z',
}

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

describe('useNotifications', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('exposes the rows', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, [notification])))

    const { result } = renderHook(() => useNotifications(), { wrapper })

    await waitFor(() => expect(result.current.data).toEqual([notification]))
  })

  it('invalidates the list after markNotificationRead resolves, refetching from the list endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockJsonResponse(200, [notification]))
      .mockResolvedValueOnce(mockJsonResponse(200, { status: 'read' }))
      .mockResolvedValueOnce(mockJsonResponse(200, [{ ...notification, readAt: '2026-08-02T00:00:00.000Z' }]))
    vi.stubGlobal('fetch', fetchMock)

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    function combinedWrapper({ children }: { children: React.ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }

    const { result: listResult } = renderHook(() => useNotifications(), { wrapper: combinedWrapper })
    await waitFor(() => expect(listResult.current.data).toEqual([notification]))

    const { result: mutationResult } = renderHook(() => useMarkNotificationRead(), { wrapper: combinedWrapper })
    await mutationResult.current.mutateAsync('n1')

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    const thirdCallUrl = fetchMock.mock.calls[2]![0] as string
    expect(thirdCallUrl).toBe('/api/notifications?limit=50&offset=0')
  })
})
