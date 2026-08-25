import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockJsonResponse } from '../lib/api'
import {
  approveUser,
  forceRevokeMcpConnection,
  forceRevokeShare,
  listAdminMcpConnections,
  listAdminUsers,
  listAuditTrail,
  listSecurityEvents,
  transferVaultOwner,
} from './admin'

describe('admin api', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('listAdminUsers filters by status only when one is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, []))
    vi.stubGlobal('fetch', fetchMock)

    await listAdminUsers()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/admin/users', expect.anything())

    await listAdminUsers('pending_approval')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/admin/users?status=pending_approval',
      expect.anything(),
    )
  })

  it('preserves a null emailVerifiedAt rather than coercing it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(200, [
          {
            id: 'u1',
            email: 'waiting@example.com',
            status: 'pending_approval',
            role: 'member',
            emailVerifiedAt: null,
            createdAt: '2026-08-01T00:00:00.000Z',
          },
        ]),
      ),
    )
    const rows = await listAdminUsers('pending_approval')
    expect(rows[0]!.emailVerifiedAt).toBeNull()
  })

  it('the two revoke levers use the verbs the server exposes, not one shared one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'revoked' }))
    vi.stubGlobal('fetch', fetchMock)

    // A share is DELETEd; an MCP connection is POSTed to /revoke. Getting
    // these the wrong way round 404s at runtime and nowhere else.
    await forceRevokeShare('s1')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/admin/shares/s1',
      expect.objectContaining({ method: 'DELETE' }),
    )

    await forceRevokeMcpConnection('c1')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/admin/mcp-connections/c1/revoke',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('approveUser POSTs and transferVaultOwner sends the new owner id in the body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'active' }))
    vi.stubGlobal('fetch', fetchMock)

    await approveUser('u1')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/admin/users/u1/approve',
      expect.objectContaining({ method: 'POST' }),
    )

    await transferVaultOwner('v1', 'u2')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/admin/vaults/v1/transfer-owner',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ newOwnerId: 'u2' }) }),
    )
  })

  it('paginates both activity feeds through the query string', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, []))
    vi.stubGlobal('fetch', fetchMock)

    await listSecurityEvents(50, 100)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/admin/security-events?limit=50&offset=100',
      expect.anything(),
    )

    await listAuditTrail(25, 50)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/admin/audit-trail?limit=25&offset=50',
      expect.anything(),
    )
  })

  it('listAdminMcpConnections reads the instance-wide route, not the per-account one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, []))
    vi.stubGlobal('fetch', fetchMock)
    await listAdminMcpConnections()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/admin/mcp-connections', expect.anything())
  })
})
