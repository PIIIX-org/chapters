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

  it('excludes a trashed (soft-deleted) vault from stats and the vault list', async () => {
    const owner = await createActiveUser()
    const ownerCookie2 = await loginCookie(app, owner.email)
    const trashedVault = (
      (await app.inject({
        method: 'POST',
        url: '/api/vaults',
        headers: { cookie: ownerCookie2 },
        body: { name: 'To be trashed' },
      })).json() as { id: string }
    ).id

    const before = (
      await app.inject({ method: 'GET', url: '/api/admin/stats', headers: { cookie: adminCookie } })
    ).json() as { vaults: number }

    await app.inject({
      method: 'DELETE',
      url: `/api/vaults/${trashedVault}`,
      headers: { cookie: ownerCookie2 },
    })

    const after = (
      await app.inject({ method: 'GET', url: '/api/admin/stats', headers: { cookie: adminCookie } })
    ).json() as { vaults: number }
    expect(after.vaults).toBe(before.vaults - 1)

    const vaultsRes = await app.inject({
      method: 'GET',
      url: '/api/admin/vaults',
      headers: { cookie: adminCookie },
    })
    const rows = vaultsRes.json() as Array<{ id: string }>
    expect(rows.some((v) => v.id === trashedVault)).toBe(false)
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
  it('lists MCP connections instance-wide, with live and revoked distinguishable, and never a token hash', async () => {
    // Its own connections, not the shared fixture — this must not depend on
    // whether the revoke test below has run yet.
    const live = (
      await app.inject({
        method: 'POST',
        url: '/api/mcp-connections',
        headers: { cookie: ownerCookie },
        body: { name: 'still-live', scope: 'account' },
      })
    ).json() as { id: string; token: string }
    const dead = (
      await app.inject({
        method: 'POST',
        url: '/api/mcp-connections',
        headers: { cookie: granteeCookie },
        body: { name: 'already-dead', scope: 'account' },
      })
    ).json() as { id: string }
    await app.inject({
      method: 'POST',
      url: `/api/mcp-connections/${dead.id}/revoke`,
      headers: { cookie: granteeCookie },
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/mcp-connections',
      headers: { cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const rows = res.json() as Array<{
      id: string
      name: string
      userEmail: string
      revokedAt: string | null
      tokenHash?: string
    }>

    // Instance-wide: connections belonging to two different users, neither of
    // whom is the admin making the call.
    const liveRow = rows.find((r) => r.id === live.id)
    const deadRow = rows.find((r) => r.id === dead.id)
    expect(liveRow?.name).toBe('still-live')
    expect(liveRow?.revokedAt).toBeNull()
    expect(deadRow?.revokedAt).not.toBeNull()
    expect(liveRow!.userEmail).not.toBe(deadRow!.userEmail)

    // Metadata only: no hash on the row, and the raw token never appears.
    expect(liveRow).not.toHaveProperty('tokenHash')
    expect(res.body).not.toContain(live.token)
  })

  it('the approval queue shows whether the pending user verified their email', async () => {
    // Mixed on purpose: approving the unverified one still leaves them locked
    // out by routes.ts:169, so a queue that cannot tell them apart is broken.
    const verified = await createActiveUser({
      status: 'pending_approval',
      emailVerifiedAt: new Date(),
    })
    const unverified = await createActiveUser({
      status: 'pending_approval',
      emailVerifiedAt: null,
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/users?status=pending_approval',
      headers: { cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const rows = res.json() as Array<{ id: string; status: string; emailVerifiedAt: string | null }>
    expect(rows.every((r) => r.status === 'pending_approval')).toBe(true)
    expect(rows.find((r) => r.id === verified.id)?.emailVerifiedAt).not.toBeNull()
    expect(rows.find((r) => r.id === unverified.id)?.emailVerifiedAt).toBeNull()
  })

  it('non-admins get nothing from the two new reads either', async () => {
    for (const url of ['/api/admin/mcp-connections', '/api/admin/users']) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie: ownerCookie } })
      expect(res.statusCode).toBe(403)
    }
  })
})
