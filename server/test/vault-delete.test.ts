import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
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
