import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
let cookie: string
let vaultId: string

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  vaultId = (
    (await app.inject({
      method: 'POST',
      url: '/api/vaults',
      headers: { cookie },
      body: { name: 'Pref vault' },
    })).json() as { id: string }
  ).id
})

afterAll(async () => app.close())

describe('graph preference read', () => {
  it('defaults to include:false when no row exists', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/graph-preference`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ include: false })
  })

  it('reads back what PUT wrote', async () => {
    await app.inject({
      method: 'PUT',
      url: `/api/vaults/${vaultId}/graph-preference`,
      headers: { cookie },
      body: { include: true },
    })
    const res = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/graph-preference`,
      headers: { cookie },
    })
    expect(res.json()).toEqual({ include: true })
  })

  it('404s for a vault the caller cannot reach', async () => {
    const stranger = await createActiveUser()
    const strangerCookie = await loginCookie(app, stranger.email)
    const res = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/graph-preference`,
      headers: { cookie: strangerCookie },
    })
    expect(res.statusCode).toBe(404)
  })
})
