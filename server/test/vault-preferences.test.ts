import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
let cookie: string
let user2Cookie: string

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  const user = await createActiveUser()
  cookie = await loginCookie(app, user.email)

  const user2 = await createActiveUser()
  user2Cookie = await loginCookie(app, user2.email)
})

afterAll(async () => app.close())

describe('/api/me/vault-preferences', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/me/vault-preferences',
    })
    expect(res.statusCode).toBe(401)
  })

  it('defaults to online storage mode and empty mappings when no row exists', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/me/vault-preferences',
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      storageMode: 'online',
      folders: {},
      folderColors: {},
      vaultColors: {},
      favorites: {},
    })
  })

  it('updates preferences via PUT and reads them back via GET', async () => {
    const payload = {
      storageMode: 'online' as const,
      folders: {
        'vault-1': 'Work',
        'vault-2': 'Personal',
      },
      folderColors: {
        Work: 'blue',
        Personal: 'emerald',
      },
      vaultColors: {
        'vault-1': 'rose',
      },
      favorites: {
        'vault-1': true,
      },
    }

    const putRes = await app.inject({
      method: 'PUT',
      url: '/api/me/vault-preferences',
      headers: { cookie },
      body: payload,
    })

    expect(putRes.statusCode).toBe(200)
    expect(putRes.json()).toEqual(payload)

    const getRes = await app.inject({
      method: 'GET',
      url: '/api/me/vault-preferences',
      headers: { cookie },
    })
    expect(getRes.statusCode).toBe(200)
    expect(getRes.json()).toEqual(payload)
  })

  it('supports updating storageMode to local', async () => {
    const putRes = await app.inject({
      method: 'PUT',
      url: '/api/me/vault-preferences',
      headers: { cookie },
      body: { storageMode: 'local' },
    })

    expect(putRes.statusCode).toBe(200)
    expect(putRes.json().storageMode).toBe('local')
    // Existing folders/colors should be preserved
    expect(putRes.json().folders).toEqual({
      'vault-1': 'Work',
      'vault-2': 'Personal',
    })
  })

  it('isolates preferences between different users', async () => {
    const user2Get = await app.inject({
      method: 'GET',
      url: '/api/me/vault-preferences',
      headers: { cookie: user2Cookie },
    })
    expect(user2Get.statusCode).toBe(200)
    expect(user2Get.json()).toEqual({
      storageMode: 'online',
      folders: {},
      folderColors: {},
      vaultColors: {},
      favorites: {},
    })
  })
})
