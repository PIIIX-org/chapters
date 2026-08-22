import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { and, eq, or } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { notes, semanticEdges, vaults } from '../src/db/schema.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
let ownerCookie: string
let otherCookie: string

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  const owner = await createActiveUser()
  const other = await createActiveUser()
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

  it('removes the vault, its notes, and their semantic edges', async () => {
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
  })
})
