import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockJsonResponse } from '../lib/api'
import { createVaultMcpConnection, listMcpConnections, revokeMcpConnection } from './mcp'

describe('mcp api', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('listMcpConnections calls GET /api/mcp-connections with no filter param', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, []))
    vi.stubGlobal('fetch', fetchMock)

    await listMcpConnections()

    expect(fetchMock).toHaveBeenCalledWith('/api/mcp-connections', expect.objectContaining({ credentials: 'include' }))
  })

  it('createVaultMcpConnection POSTs /api/mcp-connections with scope vault and the vaultId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, { id: 'c1', token: 'raw-token' }))
    vi.stubGlobal('fetch', fetchMock)

    await createVaultMcpConnection('Claude', 'v1')

    expect(fetchMock).toHaveBeenCalledWith('/api/mcp-connections', expect.objectContaining({ method: 'POST' }))
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Claude', scope: 'vault', vaultId: 'v1' })
  })

  it('revokeMcpConnection POSTs /api/mcp-connections/:id/revoke, never DELETE', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'revoked' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await revokeMcpConnection('c1')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/mcp-connections/c1/revoke',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(result.status).toBe('revoked')
  })
})
