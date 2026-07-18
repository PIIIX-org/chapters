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

async function makeRepoWithToken() {
  const owner = await createActiveUser()
  const cookie = await loginCookie(app, owner.email)
  const repo = (
    await app.inject({
      method: 'POST',
      url: '/api/repositories',
      headers: { cookie },
      body: { name: 'push-test', ingestionMethod: 'agent_push' },
    })
  ).json() as { id: string }
  const { token } = (
    await app.inject({
      method: 'POST',
      url: `/api/repositories/${repo.id}/sync-tokens`,
      headers: { cookie },
    })
  ).json() as { token: string }
  return { repoId: repo.id, token, cookie }
}

describe('agent/CLI push ingestion', () => {
  it('syncs files with a valid token', async () => {
    const { token } = await makeRepoWithToken()
    const res = await app.inject({
      method: 'POST',
      url: '/repositories/sync',
      headers: { authorization: `Bearer ${token}` },
      body: {
        files: [{ path: 'main.go', content: 'package main' }],
        currentPaths: ['main.go'],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ created: 1, updated: 0, deleted: 0, unchanged: 0 })
  })

  it('rejects a missing or revoked token', async () => {
    const { repoId, token, cookie } = await makeRepoWithToken()

    const noAuth = await app.inject({
      method: 'POST',
      url: '/repositories/sync',
      body: { files: [], currentPaths: [] },
    })
    expect(noAuth.statusCode).toBe(401)

    const listed = (
      await app.inject({
        method: 'GET',
        url: `/api/repositories/${repoId}/sync-tokens`,
        headers: { cookie },
      })
    ).json() as Array<{ id: string }>
    await app.inject({
      method: 'POST',
      url: `/api/repositories/${repoId}/sync-tokens/${listed[0]!.id}/revoke`,
      headers: { cookie },
    })
    const revoked = await app.inject({
      method: 'POST',
      url: '/repositories/sync',
      headers: { authorization: `Bearer ${token}` },
      body: { files: [], currentPaths: [] },
    })
    expect(revoked.statusCode).toBe(401)
  })
})
