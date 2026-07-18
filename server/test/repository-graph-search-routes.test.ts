import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
beforeAll(async () => {
  app = await buildApp()
  await app.ready()
})
afterAll(async () => app.close())

describe('repository-scoped and merged graph/search routes', () => {
  it('repo-only graph and search endpoints work and are permission-gated', async () => {
    const owner = await createActiveUser()
    const stranger = await createActiveUser()
    const ownerCookie = await loginCookie(app, owner.email)
    const strangerCookie = await loginCookie(app, stranger.email)
    const repo = (
      await app.inject({
        method: 'POST',
        url: '/api/repositories',
        headers: { cookie: ownerCookie },
        body: { name: 'route-repo', ingestionMethod: 'agent_push' },
      })
    ).json() as { id: string }
    const { token } = (
      await app.inject({
        method: 'POST',
        url: `/api/repositories/${repo.id}/sync-tokens`,
        headers: { cookie: ownerCookie },
      })
    ).json() as { token: string }
    await app.inject({
      method: 'POST',
      url: '/repositories/sync',
      headers: { authorization: `Bearer ${token}` },
      body: { files: [{ path: 'wombat.ts', content: 'export const wombatMarker = 1' }], currentPaths: ['wombat.ts'] },
    })
    await flushExtraction()

    const graph = await app.inject({
      method: 'GET',
      url: `/api/repositories/${repo.id}/graph`,
      headers: { cookie: ownerCookie },
    })
    expect(graph.statusCode).toBe(200)
    expect((graph.json() as { nodes: unknown[] }).nodes).toHaveLength(1)

    const search = await app.inject({
      method: 'GET',
      url: `/api/repositories/${repo.id}/search?q=wombatMarker`,
      headers: { cookie: ownerCookie },
    })
    expect(search.statusCode).toBe(200)
    expect((search.json() as unknown[]).length).toBeGreaterThan(0)

    const deniedGraph = await app.inject({
      method: 'GET',
      url: `/api/repositories/${repo.id}/graph`,
      headers: { cookie: strangerCookie },
    })
    expect(deniedGraph.statusCode).toBe(404)
    const deniedSearch = await app.inject({
      method: 'GET',
      url: `/api/repositories/${repo.id}/search?q=wombatMarker`,
      headers: { cookie: strangerCookie },
    })
    expect(deniedSearch.statusCode).toBe(404)
  })

  it('merged graph includes an opted-in mergeable repository', async () => {
    const owner = await createActiveUser()
    const cookie = await loginCookie(app, owner.email)
    const repo = (
      await app.inject({
        method: 'POST',
        url: '/api/repositories',
        headers: { cookie },
        body: { name: 'merge-repo', ingestionMethod: 'agent_push' },
      })
    ).json() as { id: string }
    const { token } = (
      await app.inject({
        method: 'POST',
        url: `/api/repositories/${repo.id}/sync-tokens`,
        headers: { cookie },
      })
    ).json() as { token: string }
    await app.inject({
      method: 'POST',
      url: '/repositories/sync',
      headers: { authorization: `Bearer ${token}` },
      body: { files: [{ path: 'merged.go', content: 'package main' }], currentPaths: ['merged.go'] },
    })
    await flushExtraction()

    // Not mergeable yet, preference set → still absent from the merged graph.
    await app.inject({
      method: 'PUT',
      url: `/api/repositories/${repo.id}/graph-preference`,
      headers: { cookie },
      body: { include: true },
    })
    let merged = (
      await app.inject({ method: 'GET', url: '/api/graph/merged', headers: { cookie } })
    ).json() as { nodes: unknown[] }
    expect(merged.nodes).toHaveLength(0)

    await app.inject({
      method: 'PATCH',
      url: `/api/repositories/${repo.id}`,
      headers: { cookie },
      body: { mergeable: true },
    })
    merged = (
      await app.inject({ method: 'GET', url: '/api/graph/merged', headers: { cookie } })
    ).json() as { nodes: unknown[] }
    expect(merged.nodes.length).toBeGreaterThan(0)
  })

  it('search everywhere finds a result in any accessible repository, unmergeable or not', async () => {
    const owner = await createActiveUser()
    const cookie = await loginCookie(app, owner.email)
    const repo = (
      await app.inject({
        method: 'POST',
        url: '/api/repositories',
        headers: { cookie },
        body: { name: 'everywhere-repo', ingestionMethod: 'agent_push' },
      })
    ).json() as { id: string }
    const { token } = (
      await app.inject({
        method: 'POST',
        url: `/api/repositories/${repo.id}/sync-tokens`,
        headers: { cookie },
      })
    ).json() as { token: string }
    await app.inject({
      method: 'POST',
      url: '/repositories/sync',
      headers: { authorization: `Bearer ${token}` },
      body: {
        files: [{ path: 'findme.py', content: 'ridiculousuniquetoken = True' }],
        currentPaths: ['findme.py'],
      },
    })
    await flushExtraction()

    const res = await app.inject({
      method: 'GET',
      url: '/api/search?q=ridiculousuniquetoken',
      headers: { cookie },
    })
    expect((res.json() as unknown[]).length).toBeGreaterThan(0)
  })
})
