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

  it('graph-preference defaults to excluded and 404s for a stranger', async () => {
    const owner = await createActiveUser()
    const stranger = await createActiveUser()
    const ownerCookie = await loginCookie(app, owner.email)
    const strangerCookie = await loginCookie(app, stranger.email)
    const repo = (
      await app.inject({
        method: 'POST',
        url: '/api/repositories',
        headers: { cookie: ownerCookie },
        body: { name: 'pref-repo', ingestionMethod: 'agent_push' },
      })
    ).json() as { id: string }

    const pref = await app.inject({
      method: 'GET',
      url: `/api/repositories/${repo.id}/graph-preference`,
      headers: { cookie: ownerCookie },
    })
    expect(pref.statusCode).toBe(200)
    expect(pref.json()).toEqual({ include: false })

    const denied = await app.inject({
      method: 'GET',
      url: `/api/repositories/${repo.id}/graph-preference`,
      headers: { cookie: strangerCookie },
    })
    expect(denied.statusCode).toBe(404)
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

  it('graph community drill-down actually filters (not silently ignored)', async () => {
    const owner = await createActiveUser()
    const cookie = await loginCookie(app, owner.email)
    const repo = (
      await app.inject({
        method: 'POST',
        url: '/api/repositories',
        headers: { cookie },
        body: { name: 'community-repo', ingestionMethod: 'agent_push' },
      })
    ).json() as { id: string }
    const { token } = (
      await app.inject({
        method: 'POST',
        url: `/api/repositories/${repo.id}/sync-tokens`,
        headers: { cookie },
      })
    ).json() as { token: string }
    // src/a.ts + src/b.ts share language and top-level dir → one community.
    // other/lonely.py shares neither → its own, disconnected, community.
    await app.inject({
      method: 'POST',
      url: '/repositories/sync',
      headers: { authorization: `Bearer ${token}` },
      body: {
        files: [
          { path: 'src/a.ts', content: 'export const a = 1' },
          { path: 'src/b.ts', content: 'export const b = 2' },
          { path: 'other/lonely.py', content: 'lonely = True' },
        ],
        currentPaths: ['src/a.ts', 'src/b.ts', 'other/lonely.py'],
      },
    })
    await flushExtraction()

    const plain = (
      await app.inject({ method: 'GET', url: `/api/repositories/${repo.id}/graph`, headers: { cookie } })
    ).json() as { nodes: Array<{ id: string; community: number }> }
    expect(plain.nodes).toHaveLength(3)

    const targetCommunity = plain.nodes[0]!.community
    const filtered = (
      await app.inject({
        method: 'GET',
        url: `/api/repositories/${repo.id}/graph?community=${targetCommunity}`,
        headers: { cookie },
      })
    ).json() as { nodes: Array<{ id: string; community: number }> }
    // This fails (returns all 3) if the community param is dropped.
    expect(filtered.nodes.length).toBeLessThan(plain.nodes.length)
    expect(filtered.nodes.every((n) => n.community === targetCommunity)).toBe(true)
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
