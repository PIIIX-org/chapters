import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { resolveMcpToken } from '../src/vaults/mcp-connection-routes.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
let adminCookie: string
let ownerCookie: string
let granteeCookie: string
let vaultId: string
let shareId: string
let mcpConnectionId: string
let mcpToken: string

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  const admin = await createActiveUser({ role: 'admin' })
  const owner = await createActiveUser()
  const grantee = await createActiveUser()
  adminCookie = await loginCookie(app, admin.email)
  ownerCookie = await loginCookie(app, owner.email)
  granteeCookie = await loginCookie(app, grantee.email)

  vaultId = (
    (await app.inject({
      method: 'POST',
      url: '/api/vaults',
      headers: { cookie: ownerCookie },
      body: { name: 'Oversight vault' },
    })).json() as { id: string }
  ).id
  shareId = (
    (await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/shares`,
      headers: { cookie: ownerCookie },
      body: { granteeType: 'user', granteeId: grantee.id, permission: 'edit' },
    })).json() as { id: string }
  ).id
  await app.inject({
    method: 'POST',
    url: `/api/vaults/${vaultId}/notes`,
    headers: { cookie: ownerCookie },
    body: { type: 'docs', name: 'secret', body: 'TOP-SECRET-CONTENT tracked here.' },
  })
  const conn = (
    await app.inject({
      method: 'POST',
      url: '/api/mcp-connections',
      headers: { cookie: ownerCookie },
      body: { name: 'agent', scope: 'account' },
    })
  ).json() as { id: string; token: string }
  mcpConnectionId = conn.id
  mcpToken = conn.token
})

afterAll(async () => app.close())

describe('admin oversight dashboard', () => {
  it('serves aggregate stats and vault/team oversight — metadata only, never content', async () => {
    const stats = await app.inject({
      method: 'GET',
      url: '/api/admin/stats',
      headers: { cookie: adminCookie },
    })
    expect(stats.statusCode).toBe(200)
    const parsed = stats.json() as { vaults: number; storageBytes: number }
    expect(parsed.vaults).toBeGreaterThan(0)
    expect(parsed.storageBytes).toBeGreaterThan(0)

    const vaultsRes = await app.inject({
      method: 'GET',
      url: '/api/admin/vaults',
      headers: { cookie: adminCookie },
    })
    const vaultRows = vaultsRes.json() as Array<{
      id: string
      noteCount: number
      shareCount: number
    }>
    const row = vaultRows.find((v) => v.id === vaultId)!
    expect(row.noteCount).toBe(1)
    expect(row.shareCount).toBe(1)
    // The load-bearing rule: no note content anywhere in the response.
    expect(vaultsRes.body).not.toContain('TOP-SECRET-CONTENT')
  })

  it('audit trail shows who changed what, without content', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/audit-trail',
      headers: { cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const rows = res.json() as Array<{ notePath: string; actorType: string }>
    expect(rows.some((r) => r.notePath === 'docs/secret')).toBe(true)
    expect(res.body).not.toContain('TOP-SECRET-CONTENT')
  })

  it('non-admins get nothing', async () => {
    for (const url of ['/api/admin/stats', '/api/admin/vaults', '/api/admin/audit-trail']) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie: ownerCookie } })
      expect(res.statusCode).toBe(403)
    }
  })

  it('force-revoking a share cuts access immediately', async () => {
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/vaults/${vaultId}/access`,
          headers: { cookie: granteeCookie },
        })
      ).statusCode,
    ).toBe(200)

    const revoke = await app.inject({
      method: 'DELETE',
      url: `/api/admin/shares/${shareId}`,
      headers: { cookie: adminCookie },
    })
    expect(revoke.statusCode).toBe(200)

    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/vaults/${vaultId}/access`,
          headers: { cookie: granteeCookie },
        })
      ).statusCode,
    ).toBe(404)
  })

  it('force-revoking an MCP connection kills its token', async () => {
    expect(await resolveMcpToken(mcpToken)).not.toBeNull()
    const revoke = await app.inject({
      method: 'POST',
      url: `/api/admin/mcp-connections/${mcpConnectionId}/revoke`,
      headers: { cookie: adminCookie },
    })
    expect(revoke.statusCode).toBe(200)
    expect(await resolveMcpToken(mcpToken)).toBeNull()
  })
})
