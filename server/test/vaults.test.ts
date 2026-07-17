import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { notifications } from '../src/db/schema.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
beforeAll(async () => {
  app = await buildApp()
  await app.ready()
})
afterAll(async () => app.close())

describe('vault + share endpoints', () => {
  it('owner shares, grantee sees the vault, non-owner cannot manage shares', async () => {
    const owner = await createActiveUser()
    const grantee = await createActiveUser()
    const ownerCookie = await loginCookie(app, owner.email)
    const granteeCookie = await loginCookie(app, grantee.email)

    const created = await app.inject({
      method: 'POST',
      url: '/api/vaults',
      headers: { cookie: ownerCookie },
      body: { name: 'Knowledge' },
    })
    expect(created.statusCode).toBe(200)
    const vault = created.json() as { id: string; mergeable: boolean }
    expect(vault.mergeable).toBe(false) // private by default

    // Grantee can't see it yet.
    let list = (
      await app.inject({ method: 'GET', url: '/api/vaults', headers: { cookie: granteeCookie } })
    ).json() as Array<{ id: string; access?: string }>
    expect(list.find((v) => v.id === vault.id)).toBeUndefined()

    const share = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vault.id}/shares`,
      headers: { cookie: ownerCookie },
      body: { granteeType: 'user', granteeId: grantee.id, permission: 'read' },
    })
    expect(share.statusCode).toBe(200)

    list = (
      await app.inject({ method: 'GET', url: '/api/vaults', headers: { cookie: granteeCookie } })
    ).json() as Array<{ id: string; access: string }>
    expect(list.find((v) => v.id === vault.id)?.access).toBe('read')

    // Editors cannot re-share (owner-only) — grantee gets 404, not 403,
    // to avoid confirming the vault's existence pattern.
    const reshare = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vault.id}/shares`,
      headers: { cookie: granteeCookie },
      body: { granteeType: 'user', granteeId: owner.id, permission: 'edit' },
    })
    expect(reshare.statusCode).toBe(404)

    // Share created a notification for the grantee.
    const notes = await db
      .select()
      .from(notifications)
      .where(eq(notifications.recipientId, grantee.id))
    expect(notes.some((n) => n.type === 'vault_shared')).toBe(true)
  })

  it('graph preference requires current access', async () => {
    const owner = await createActiveUser()
    const stranger = await createActiveUser()
    const ownerCookie = await loginCookie(app, owner.email)
    const strangerCookie = await loginCookie(app, stranger.email)
    const vault = (
      await app.inject({
        method: 'POST',
        url: '/api/vaults',
        headers: { cookie: ownerCookie },
        body: { name: 'Private' },
      })
    ).json() as { id: string }

    const denied = await app.inject({
      method: 'PUT',
      url: `/api/vaults/${vault.id}/graph-preference`,
      headers: { cookie: strangerCookie },
      body: { include: true },
    })
    expect(denied.statusCode).toBe(404)

    const allowed = await app.inject({
      method: 'PUT',
      url: `/api/vaults/${vault.id}/graph-preference`,
      headers: { cookie: ownerCookie },
      body: { include: true },
    })
    expect(allowed.statusCode).toBe(200)
  })

  it('owner-initiated transfer hands the vault over', async () => {
    const owner = await createActiveUser()
    const next = await createActiveUser()
    const ownerCookie = await loginCookie(app, owner.email)
    const vault = (
      await app.inject({
        method: 'POST',
        url: '/api/vaults',
        headers: { cookie: ownerCookie },
        body: { name: 'Handover' },
      })
    ).json() as { id: string }

    const res = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vault.id}/transfer`,
      headers: { cookie: ownerCookie },
      body: { newOwnerId: next.id },
    })
    expect(res.statusCode).toBe(200)

    const access = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vault.id}/access`,
      headers: { cookie: await loginCookie(app, next.email) },
    })
    expect((access.json() as { access: string }).access).toBe('owner')
  })

  it('team membership change notifies owners of vaults shared to that team', async () => {
    const vaultOwner = await createActiveUser()
    const teamOwner = await createActiveUser()
    const newcomer = await createActiveUser()
    const vaultOwnerCookie = await loginCookie(app, vaultOwner.email)
    const teamOwnerCookie = await loginCookie(app, teamOwner.email)

    const team = (
      await app.inject({
        method: 'POST',
        url: '/api/teams',
        headers: { cookie: teamOwnerCookie },
        body: { name: 'Research' },
      })
    ).json() as { id: string }
    const vault = (
      await app.inject({
        method: 'POST',
        url: '/api/vaults',
        headers: { cookie: vaultOwnerCookie },
        body: { name: 'Shared-to-team' },
      })
    ).json() as { id: string }
    await app.inject({
      method: 'POST',
      url: `/api/vaults/${vault.id}/shares`,
      headers: { cookie: vaultOwnerCookie },
      body: { granteeType: 'team', granteeId: team.id, permission: 'read' },
    })

    await app.inject({
      method: 'POST',
      url: `/api/teams/${team.id}/members`,
      headers: { cookie: teamOwnerCookie },
      body: { userId: newcomer.id },
    })

    const ownerNotes = await db
      .select()
      .from(notifications)
      .where(eq(notifications.recipientId, vaultOwner.id))
    expect(ownerNotes.some((n) => n.type === 'team_membership_changed')).toBe(true)
  })
})
