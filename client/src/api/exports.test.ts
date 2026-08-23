import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockJsonResponse } from '../lib/api'
import { createExportLink, exportDownloadUrl, revokeExportLink } from './exports'

describe('exports api', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('exportDownloadUrl points at the vault-scoped zip route', () => {
    expect(exportDownloadUrl('v1')).toBe('/api/vaults/v1/export')
  })

  it('createExportLink POSTs /vaults/:id/export-links with no body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockJsonResponse(200, { id: 'l1', token: 'raw-token', expiresAt: '2026-08-24T00:00:00.000Z' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await createExportLink('v1')

    expect(fetchMock).toHaveBeenCalledWith('/api/vaults/v1/export-links', expect.objectContaining({ method: 'POST' }))
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.body).toBeUndefined()
    expect(result).toEqual({ id: 'l1', token: 'raw-token', expiresAt: '2026-08-24T00:00:00.000Z' })
  })

  it('revokeExportLink DELETEs /vaults/:id/export-links/:linkId, keyed by link id not token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'revoked' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await revokeExportLink('v1', 'l1')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/vaults/v1/export-links/l1',
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(result.status).toBe('revoked')
  })
})
