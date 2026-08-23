import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockJsonResponse, ApiError } from '../lib/api'
import { listNotifications, markNotificationRead } from './notifications'

describe('notifications api', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('listNotifications calls GET /api/notifications?limit=&offset= and preserves null readAt', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse(200, [
        {
          id: 'n1',
          recipientId: 'u1',
          type: 'mention',
          entityType: 'note',
          entityId: 'note1',
          message: 'you were mentioned',
          readAt: null,
          createdAt: '2026-08-01T00:00:00.000Z',
        },
      ]),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await listNotifications()

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/notifications?limit=50&offset=0',
      expect.objectContaining({ credentials: 'include' }),
    )
    expect(result[0]!.readAt).toBeNull()
  })

  it('markNotificationRead POSTs /api/notifications/:id/read', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'read' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await markNotificationRead('n1')

    expect(result.status).toBe('read')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/notifications/n1/read',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('a 404 from mark-read resolves rather than rejecting', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(404, { error: 'notification not found' })))

    const result = await markNotificationRead('n1')

    expect(result).toEqual({ status: 'read' })
  })

  it('a 500 from mark-read rejects with an ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(500, { error: 'boom' })))

    await expect(markNotificationRead('n1')).rejects.toBeInstanceOf(ApiError)
  })
})
