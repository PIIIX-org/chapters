import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
beforeAll(async () => {
  app = await buildApp()
  await app.ready()
})
afterAll(async () => app.close())

describe('GET /api/users/lookup', () => {
  it('finds an active user by exact email', async () => {
    const user = await createActiveUser()
    const finder = await createActiveUser()
    const cookie = await loginCookie(app, finder.email)
    const res = await app.inject({
      method: 'GET',
      url: `/api/users/lookup?email=${encodeURIComponent(user.email)}`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: user.id, email: user.email })
  })

  it('returns 404 for a pending or deactivated user', async () => {
    const pending = await createActiveUser({ status: 'pending_approval' })
    const deactivated = await createActiveUser({ status: 'deactivated' })
    const finder = await createActiveUser()
    const cookie = await loginCookie(app, finder.email)

    const resPending = await app.inject({
      method: 'GET',
      url: `/api/users/lookup?email=${encodeURIComponent(pending.email)}`,
      headers: { cookie },
    })
    expect(resPending.statusCode).toBe(404)

    const resDeactivated = await app.inject({
      method: 'GET',
      url: `/api/users/lookup?email=${encodeURIComponent(deactivated.email)}`,
      headers: { cookie },
    })
    expect(resDeactivated.statusCode).toBe(404)
  })

  it('does not match a prefix of a real email', async () => {
    const user = await createActiveUser()
    const finder = await createActiveUser()
    const cookie = await loginCookie(app, finder.email)
    const prefix = user.email.slice(0, -4)
    const res = await app.inject({
      method: 'GET',
      url: `/api/users/lookup?email=${encodeURIComponent(prefix)}`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(404)
  })

  it('normalises whitespace and case', async () => {
    const user = await createActiveUser()
    const finder = await createActiveUser()
    const cookie = await loginCookie(app, finder.email)
    const messy = `  ${user.email.toUpperCase()}  `
    const res = await app.inject({
      method: 'GET',
      url: `/api/users/lookup?email=${encodeURIComponent(messy)}`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: user.id, email: user.email })
  })

  it('requires a session', async () => {
    const user = await createActiveUser()
    const res = await app.inject({
      method: 'GET',
      url: `/api/users/lookup?email=${encodeURIComponent(user.email)}`,
    })
    expect(res.statusCode).toBe(401)
  })
})
