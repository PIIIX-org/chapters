import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockJsonResponse } from '../lib/api'
import { createMcpConnection, listMcpConnections, listMcpTools, revokeMcpConnection } from './mcp'

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

  it('createMcpConnection POSTs /api/mcp-connections with the target and the capabilities chosen', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, { id: 'c1', token: 'raw-token' }))
    vi.stubGlobal('fetch', fetchMock)

    await createMcpConnection(
      { scope: 'vault', vaultId: 'v1' },
      { name: 'Claude', access: 'read', profile: 'reader', allowedTools: ['read_note'], expiresAt: '2026-11-15T00:00:00.000Z' },
    )

    expect(fetchMock).toHaveBeenCalledWith('/api/mcp-connections', expect.objectContaining({ method: 'POST' }))
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'Claude',
      scope: 'vault',
      vaultId: 'v1',
      access: 'read',
      profile: 'reader',
      allowedTools: ['read_note'],
      expiresAt: '2026-11-15T00:00:00.000Z',
    })
  })

  it('createMcpConnection for the account sends no vaultId, allow-list or expiry when none is chosen', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, { id: 'c1', token: 'raw-token' }))
    vi.stubGlobal('fetch', fetchMock)

    await createMcpConnection({ scope: 'account' }, { name: 'Laptop', access: 'admin', profile: 'admin' })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Laptop', scope: 'account', access: 'admin', profile: 'admin' })
  })

  it('listMcpTools calls GET /api/mcp-connections/tools', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, []))
    vi.stubGlobal('fetch', fetchMock)

    await listMcpTools()

    expect(fetchMock).toHaveBeenCalledWith('/api/mcp-connections/tools', expect.objectContaining({ credentials: 'include' }))
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
