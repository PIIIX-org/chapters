import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiFetch, ApiError, mockJsonResponse } from './api'

describe('apiFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('prefixes the path with /api and includes credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await apiFetch<{ ok: boolean }>('/me')

    expect(result).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/me',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('throws ApiError with the parsed body on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockJsonResponse(401, { error: 'invalid credentials' })),
    )

    await expect(apiFetch('/login', { method: 'POST' })).rejects.toMatchObject({
      status: 401,
      body: { error: 'invalid credentials' },
    })
  })

  it('ApiError.message falls back to the parsed error field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockJsonResponse(403, { error: 'invalid setup token' })),
    )

    try {
      await apiFetch('/setup', { method: 'POST' })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).message).toBe('invalid setup token')
    }
  })
})
