import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { and, eq, or } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { notes, notifications, semanticEdges, vaults } from '../src/db/schema.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
let ownerCookie: string
let otherCookie: string
let otherId: string

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  const owner = await createActiveUser()
  const other = await createActiveUser()
  otherId = other.id
  ownerCookie = await loginCookie(app, owner.email)
  otherCookie = await loginCookie(app, other.email)
})

afterAll(async () => app.close())

async function makeVault(cookie: string, name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/vaults',
    headers: { cookie },
    body: { name },
  })
  return (res.json() as { id: string }).id
}

describe('vault soft delete', () => {
  it('hides the vault from the owner’s list', async () => {
    const id = await makeVault(ownerCookie, 'Doomed')
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/vaults/${id}`,
      headers: { cookie: ownerCookie },
    })
    expect(del.statusCode).toBe(200)
    expect(del.json()).toEqual({ status: 'trashed', id })

    const list = (
      await app.inject({ method: 'GET', url: '/api/vaults', headers: { cookie: ownerCookie } })
    ).json() as Array<{ id: string }>
    expect(list.some((v) => v.id === id)).toBe(false)
  })

  it('makes the vault unreachable afterwards', async () => {
    const id = await makeVault(ownerCookie, 'Also doomed')
    await app.inject({ method: 'DELETE', url: `/api/vaults/${id}`, headers: { cookie: ownerCookie } })
    const tree = await app.inject({
      method: 'GET',
      url: `/api/vaults/${id}/tree`,
      headers: { cookie: ownerCookie },
    })
    expect(tree.statusCode).toBe(404)
  })

  it('refuses a non-owner', async () => {
    const id = await makeVault(ownerCookie, 'Not yours')
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/vaults/${id}`,
      headers: { cookie: otherCookie },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('vault purge', () => {
  it('refuses to purge a vault that is not trashed', async () => {
    const id = await makeVault(ownerCookie, 'Still live')
    const res = await app.inject({
      method: 'POST',
      url: `/api/vaults/${id}/purge`,
      headers: { cookie: ownerCookie },
    })
    expect(res.statusCode).toBe(409)
  })

  it('removes the vault, its notes, their semantic edges, and its notifications', async () => {
    const id = await makeVault(ownerCookie, 'Purge me')
    await app.inject({
      method: 'POST',
      url: `/api/vaults/${id}/notes`,
      headers: { cookie: ownerCookie },
      body: { type: 'notes', name: 'doomed', body: 'x', frontmatter: { type: 'notes' } },
    })
    const noteRows = await db.select({ id: notes.id }).from(notes).where(eq(notes.vaultId, id))
    const noteId = noteRows[0]!.id
    // semanticEdges has no FK, so it cannot cascade. Seed BOTH directions
    // against a synthetic other end — a row where the purged note is the
    // TARGET is the one a naive cleanup misses.
    const other = randomUUID()
    await db.insert(semanticEdges).values([
      { sourceType: 'note', sourceId: noteId, targetType: 'note', targetId: other, similarity: 0.9 },
      { sourceType: 'note', sourceId: other, targetType: 'note', targetId: noteId, similarity: 0.9 },
    ])
    // notifications is polymorphic with no FK either (#101). One row points
    // at the doomed vault and one at an unrelated vault id that must survive —
    // a purge that wiped the recipient's whole feed would pass a one-row check.
    const unrelatedVault = randomUUID()
    await db.insert(notifications).values([
      { recipientId: otherId, type: 'vault_shared', entityType: 'vault', entityId: id, message: 'doomed' },
      { recipientId: otherId, type: 'vault_shared', entityType: 'vault', entityId: unrelatedVault, message: 'keep' },
    ])

    await app.inject({ method: 'DELETE', url: `/api/vaults/${id}`, headers: { cookie: ownerCookie } })
    const res = await app.inject({
      method: 'POST',
      url: `/api/vaults/${id}/purge`,
      headers: { cookie: ownerCookie },
    })
    expect(res.statusCode).toBe(200)

    expect(await db.select().from(vaults).where(eq(vaults.id, id))).toEqual([])
    expect(await db.select().from(notes).where(eq(notes.vaultId, id))).toEqual([])
    const edges = await db
      .select()
      .from(semanticEdges)
      .where(
        or(
          and(eq(semanticEdges.sourceType, 'note'), eq(semanticEdges.sourceId, noteId)),
          and(eq(semanticEdges.targetType, 'note'), eq(semanticEdges.targetId, noteId)),
        ),
      )
    expect(edges).toEqual([])
    const feed = await db
      .select({ entityId: notifications.entityId })
      .from(notifications)
      .where(eq(notifications.recipientId, otherId))
    expect(feed.map((n) => n.entityId)).not.toContain(id)
    expect(feed.map((n) => n.entityId)).toContain(unrelatedVault)
  })
})

describe('vault trash list', () => {
  it('contains a soft-deleted vault and excludes live ones', async () => {
    const trashed = await makeVault(ownerCookie, 'Trashed for listing')
    const live = await makeVault(ownerCookie, 'Live for listing')
    await app.inject({ method: 'DELETE', url: `/api/vaults/${trashed}`, headers: { cookie: ownerCookie } })

    const res = await app.inject({ method: 'GET', url: '/api/vaults/trash', headers: { cookie: ownerCookie } })
    expect(res.statusCode).toBe(200)
    const ids = (res.json() as Array<{ id: string; deletedAt: string }>).map((v) => v.id)
    expect(ids).toContain(trashed)
    expect(ids).not.toContain(live)
  })

  it('does not contain another user’s trashed vault', async () => {
    const id = await makeVault(otherCookie, 'Other person’s trash')
    await app.inject({ method: 'DELETE', url: `/api/vaults/${id}`, headers: { cookie: otherCookie } })

    const res = await app.inject({ method: 'GET', url: '/api/vaults/trash', headers: { cookie: ownerCookie } })
    const ids = (res.json() as Array<{ id: string }>).map((v) => v.id)
    expect(ids).not.toContain(id)
  })

  it('is not shadowed by the /vaults/:id route', async () => {
    // If ":id" matched first, this would try to look up a vault literally
    // named "trash" and 404 instead of returning the trash list.
    const trashed = await makeVault(ownerCookie, 'Shadow check')
    await app.inject({ method: 'DELETE', url: `/api/vaults/${trashed}`, headers: { cookie: ownerCookie } })

    const res = await app.inject({ method: 'GET', url: '/api/vaults/trash', headers: { cookie: ownerCookie } })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
  })
})

describe('vault restore', () => {
  it('makes a trashed vault reappear and reachable again', async () => {
    const id = await makeVault(ownerCookie, 'Restore me')
    await app.inject({ method: 'DELETE', url: `/api/vaults/${id}`, headers: { cookie: ownerCookie } })

    const restore = await app.inject({
      method: 'POST',
      url: `/api/vaults/${id}/restore`,
      headers: { cookie: ownerCookie },
    })
    expect(restore.statusCode).toBe(200)
    expect((restore.json() as { id: string }).id).toBe(id)

    const list = (
      await app.inject({ method: 'GET', url: '/api/vaults', headers: { cookie: ownerCookie } })
    ).json() as Array<{ id: string }>
    expect(list.some((v) => v.id === id)).toBe(true)

    const tree = await app.inject({
      method: 'GET',
      url: `/api/vaults/${id}/tree`,
      headers: { cookie: ownerCookie },
    })
    expect(tree.statusCode).toBe(200)
  })

  it('409s restoring a vault that is not trashed', async () => {
    const id = await makeVault(ownerCookie, 'Never trashed')
    const res = await app.inject({
      method: 'POST',
      url: `/api/vaults/${id}/restore`,
      headers: { cookie: ownerCookie },
    })
    expect(res.statusCode).toBe(409)
  })

  it('404s a non-owner instead of 403', async () => {
    const id = await makeVault(ownerCookie, 'Not yours to restore')
    await app.inject({ method: 'DELETE', url: `/api/vaults/${id}`, headers: { cookie: ownerCookie } })

    const res = await app.inject({
      method: 'POST',
      url: `/api/vaults/${id}/restore`,
      headers: { cookie: otherCookie },
    })
    expect(res.statusCode).toBe(404)
  })
})
