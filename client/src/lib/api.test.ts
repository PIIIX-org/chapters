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
  it('declares JSON only when it is actually sending JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, {}))
    vi.stubGlobal('fetch', fetchMock)

    // Fastify 400s (FST_ERR_CTP_EMPTY_JSON_BODY) on a request that declares
    // application/json and sends no body — which is every DELETE and every
    // bodyless POST in this client.
    await apiFetch('/vaults/v1', { method: 'DELETE' })
    expect(fetchMock.mock.calls[0]![1].headers).not.toHaveProperty('Content-Type')

    await apiFetch('/vaults', { method: 'POST', body: JSON.stringify({ name: 'x' }) })
    expect(fetchMock.mock.calls[1]![1].headers).toHaveProperty('Content-Type', 'application/json')
  })
})
