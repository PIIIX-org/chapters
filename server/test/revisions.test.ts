import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { createActiveUser, loginCookie } from './helpers.js'

/**
 * The history endpoint is metadata only and always bounded: it must never
 * carry a note's text (that is what the note endpoint is for) and must never
 * read every revision of a long-lived note.
 */

interface Row {
  id: string
  actorType: string
  actorId: string | null
  action: string
  createdAt: string
}

let app: FastifyInstance
let ownerCookie: string
let readerCookie: string
let ownerId: string
let vaultId: string

const MARKER = 'QUARTZ-PELICAN-MARKER-8817'

async function history(cookie: string, path: string, query = ''): Promise<ReturnType<FastifyInstance['inject']>> {
  return app.inject({
    method: 'GET',
    url: `/api/vaults/${vaultId}/history/${path}${query}`,
    headers: { cookie },
  })
}

async function makeNote(name: string, body: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/vaults/${vaultId}/notes`,
    headers: { cookie: ownerCookie },
    body: { type: 'people', name, body },
  })
  expect(res.statusCode).toBe(200)
}

async function edit(path: string, body: string): Promise<void> {
  const res = await app.inject({
    method: 'PUT',
    url: `/api/vaults/${vaultId}/notes/${path}`,
    headers: { cookie: ownerCookie },
    body: { body },
  })
  expect(res.statusCode).toBe(200)
}

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  const owner = await createActiveUser()
  const reader = await createActiveUser()
  ownerId = owner.id
  ownerCookie = await loginCookie(app, owner.email)
  readerCookie = await loginCookie(app, reader.email)
  vaultId = (
    (
      await app.inject({
        method: 'POST',
        url: '/api/vaults',
        headers: { cookie: ownerCookie },
        body: { name: 'History vault' },
      })
    ).json() as { id: string }
  ).id
  await app.inject({
    method: 'POST',
    url: `/api/vaults/${vaultId}/shares`,
    headers: { cookie: ownerCookie },
    body: { granteeType: 'user', granteeId: reader.id, permission: 'read' },
  })

  await makeNote('attributed', `${MARKER} original`)
  await edit('people/attributed', `${MARKER} edited once`)

  // Five revisions: one create + four distinct edits (identical writes dedupe).
  await makeNote('paged', 'rev-0')
  for (let i = 1; i <= 4; i += 1) await edit('people/paged', `rev-${i}`)
}, 60_000)

afterAll(async () => app.close())

describe('GET /vaults/:id/history/* — attribution without content', () => {
  it('reports who changed the note and never leaks its text', async () => {
    const res = await history(ownerCookie, 'people/attributed')
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain(MARKER)

    const rows = res.json() as Row[]
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row).not.toHaveProperty('body')
      expect(row).not.toHaveProperty('frontmatter')
      expect(Object.keys(row).sort()).toEqual(['action', 'actorId', 'actorType', 'createdAt', 'id'])
      expect(row.actorType).toBe('user')
      expect(row.actorId).toBe(ownerId)
    }
    expect(rows.map((r) => r.action)).toEqual(['update', 'create'])
  })
})

describe('GET /vaults/:id/history/* — pagination', () => {
  it('caps the page at limit and moves the window by offset', async () => {
    const all = ((await history(ownerCookie, 'people/paged', '?limit=200')).json() as Row[]).map((r) => r.id)
    expect(all).toHaveLength(5)

    const page1 = (await history(ownerCookie, 'people/paged', '?limit=2')).json() as Row[]
    const page2 = (await history(ownerCookie, 'people/paged', '?limit=2&offset=2')).json() as Row[]
    expect(page1).toHaveLength(2)
    expect(page2).toHaveLength(2)
    expect(page1.map((r) => r.id)).toEqual(all.slice(0, 2))
    expect(page2.map((r) => r.id)).toEqual(all.slice(2, 4))
    expect(page2[0]!.id).not.toBe(page1[0]!.id)
  })

  it('rejects an out-of-range limit', async () => {
    expect((await history(ownerCookie, 'people/paged', '?limit=0')).statusCode).toBe(400)
    expect((await history(ownerCookie, 'people/paged', '?limit=201')).statusCode).toBe(400)
  })
})

describe('GET /vaults/:id/history/* — ordering', () => {
  it('returns newest first', async () => {
    const rows = (await history(ownerCookie, 'people/paged')).json() as Row[]
    expect(rows.map((r) => r.action)).toEqual(['update', 'update', 'update', 'update', 'create'])
    const times = rows.map((r) => new Date(r.createdAt).getTime())
    expect(times).toEqual([...times].sort((a, b) => b - a))
  })
})

describe('GET /vaults/:id/history/* — access', () => {
  it('hides history from a read-only grantee (edit access required)', async () => {
    const res = await history(readerCookie, 'people/attributed')
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain('update')
  })

  it('404s for a note that does not exist', async () => {
    const res = await history(ownerCookie, 'people/never-written')
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'note not found' })
  })
})
