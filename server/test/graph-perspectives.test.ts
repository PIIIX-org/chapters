import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
let ownerCookie: string
let strangerCookie: string
let vaultId: string

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  const owner = await createActiveUser({ role: 'admin' })
  ownerCookie = await loginCookie(app, owner.email)
  const stranger = await createActiveUser()
  strangerCookie = await loginCookie(app, stranger.email)

  vaultId = (
    (await app.inject({
      method: 'POST',
      url: '/api/vaults',
      headers: { cookie: ownerCookie },
      body: { name: 'Perspective Vault' },
    })).json() as { id: string }
  ).id
})

afterAll(async () => app.close())

describe('Graph Perspectives API', () => {
  it('rejects creation without a name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/graph/perspectives',
      headers: { cookie: ownerCookie },
      body: { name: '', vaultId },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toHaveProperty('error')
  })

  it('rejects creation for an inaccessible vault', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/graph/perspectives',
      headers: { cookie: strangerCookie },
      body: { name: 'Hacked View', vaultId },
    })
    expect(res.statusCode).toBe(404)
  })

  it('creates and retrieves a vault-scoped perspective', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/graph/perspectives',
      headers: { cookie: ownerCookie },
      body: {
        name: 'Architecture & ADRs',
        vaultId,
        filters: { types: ['adr', 'spec'], tags: ['architecture'], colorMode: 'attribute' },
        isShared: true,
      },
    })
    expect(createRes.statusCode).toBe(201)
    const created = createRes.json() as {
      id: string
      name: string
      vaultId: string
      filters: { types: string[]; tags: string[]; colorMode: string }
      isShared: boolean
    }
    expect(created.name).toBe('Architecture & ADRs')
    expect(created.vaultId).toBe(vaultId)
    expect(created.filters.types).toEqual(['adr', 'spec'])
    expect(created.isShared).toBe(true)

    // Query perspectives for this vault
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/graph/perspectives?vaultId=${vaultId}`,
      headers: { cookie: ownerCookie },
    })
    expect(listRes.statusCode).toBe(200)
    const list = listRes.json() as Array<{ id: string; name: string }>
    expect(list.some((p) => p.id === created.id && p.name === 'Architecture & ADRs')).toBe(true)
  })

  it('creates and retrieves a global/merged perspective', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/graph/perspectives',
      headers: { cookie: ownerCookie },
      body: {
        name: 'Global Security Overview',
        filters: { tags: ['security'], colorMode: 'community' },
        isShared: true,
      },
    })
    expect(createRes.statusCode).toBe(201)
    const created = createRes.json() as { id: string; name: string; vaultId: string | null }
    expect(created.name).toBe('Global Security Overview')
    expect(created.vaultId).toBeNull()

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/graph/perspectives',
      headers: { cookie: ownerCookie },
    })
    expect(listRes.statusCode).toBe(200)
    const list = listRes.json() as Array<{ id: string; name: string }>
    expect(list.some((p) => p.id === created.id)).toBe(true)
  })

  it('rejects global perspective creation by non-admin member', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/graph/perspectives',
      headers: { cookie: strangerCookie },
      body: {
        name: 'Malicious Global View',
        filters: { tags: ['hack'] },
        isShared: true,
      },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toHaveProperty('error')
  })

  it('allows owner to delete perspective and denies non-owner', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/graph/perspectives',
      headers: { cookie: ownerCookie },
      body: {
        name: 'Temporary View',
        vaultId,
        filters: { types: ['note'] },
        isShared: true,
      },
    })
    const created = createRes.json() as { id: string }

    // Stranger tries to delete
    const deleteStranger = await app.inject({
      method: 'DELETE',
      url: `/api/graph/perspectives/${created.id}`,
      headers: { cookie: strangerCookie },
    })
    expect(deleteStranger.statusCode).toBe(403)

    // Owner deletes
    const deleteOwner = await app.inject({
      method: 'DELETE',
      url: `/api/graph/perspectives/${created.id}`,
      headers: { cookie: ownerCookie },
    })
    expect(deleteOwner.statusCode).toBe(200)

    // Verify gone
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/graph/perspectives?vaultId=${vaultId}`,
      headers: { cookie: ownerCookie },
    })
    const list = listRes.json() as Array<{ id: string }>
    expect(list.some((p) => p.id === created.id)).toBe(false)
  })

  it('safely rejects malformed non-UUID parameters with 404 instead of throwing 500', async () => {
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/graph/perspectives?vaultId=invalid-not-uuid',
      headers: { cookie: ownerCookie },
    })
    expect(listRes.statusCode).toBe(404)

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: '/api/graph/perspectives/not-a-uuid-string',
      headers: { cookie: ownerCookie },
    })
    expect(deleteRes.statusCode).toBe(404)
    expect(deleteRes.json()).toEqual({ error: 'not found' })
  })
})
