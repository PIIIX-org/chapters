import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockJsonResponse } from '../lib/api'
import { createShare, listShares, listTeams, lookupUserByEmail, revokeShare } from './shares'

describe('shares api', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('listShares calls GET /api/vaults/:id/shares', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, []))
    vi.stubGlobal('fetch', fetchMock)

    await listShares('v1')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/vaults/v1/shares',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('createShare POSTs /api/vaults/:id/shares with the exact body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, { id: 's1' }))
    vi.stubGlobal('fetch', fetchMock)

    await createShare('v1', { granteeType: 'user', granteeId: 'u9', permission: 'edit' })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/vaults/v1/shares',
      expect.objectContaining({ method: 'POST' }),
    )
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({
      granteeType: 'user',
      granteeId: 'u9',
      permission: 'edit',
    })
  })

  it('revokeShare DELETEs /api/vaults/:id/shares/:shareId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'revoked' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await revokeShare('v1', 's1')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/vaults/v1/shares/s1',
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(result.status).toBe('revoked')
  })

  it('lookupUserByEmail calls GET /api/users/lookup with the email exact-encoded', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, { id: 'u1', email: 'ada@example.com' }))
    vi.stubGlobal('fetch', fetchMock)

    await lookupUserByEmail('ada@example.com')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/users/lookup?email=ada%40example.com',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('listTeams calls GET /api/teams', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, []))
    vi.stubGlobal('fetch', fetchMock)

    await listTeams()

    expect(fetchMock).toHaveBeenCalledWith('/api/teams', expect.objectContaining({ credentials: 'include' }))
  })
})
