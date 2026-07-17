import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
let ownerCookie: string
let strangerCookie: string
let vaultId: string

interface GraphResponse {
  nodes: Array<{ id: string; path: string; community: number }>
  edges: Array<{ source: string; target: string; kind: string }>
}

async function createNote(
  cookie: string,
  vault: string,
  type: string,
  name: string,
  body: string,
  frontmatter?: Record<string, unknown>,
) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/vaults/${vault}/notes`,
    headers: { cookie },
    body: { type, name, body, frontmatter: { type, ...frontmatter } },
  })
  expect(res.statusCode).toBe(200)
  return res.json() as { id: string; path: string }
}

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  const owner = await createActiveUser()
  const stranger = await createActiveUser()
  ownerCookie = await loginCookie(app, owner.email)
  strangerCookie = await loginCookie(app, stranger.email)
  vaultId = (
    (await app.inject({
      method: 'POST',
      url: '/api/vaults',
      headers: { cookie: ownerCookie },
      body: { name: 'Graph vault' },
    })).json() as { id: string }
  ).id

  await createNote(ownerCookie, vaultId, 'projects', 'apollo', 'Rocket engine design. See [[people/wernher]].')
  await createNote(ownerCookie, vaultId, 'people', 'wernher', 'Chief rocket engine designer for the apollo program.', { tags: ['engineering'] })
  await createNote(ownerCookie, vaultId, 'people', 'margaret', 'Software lead writing guidance software.', { tags: ['engineering'] })
  await createNote(ownerCookie, vaultId, 'notes', 'grocery', 'Buy milk and coffee beans tomorrow.')
  await flushEmbeddings()
})

afterAll(async () => app.close())

describe('graph', () => {
  it('assembles extracted, structural, and semantic edges with communities', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/graph`,
      headers: { cookie: ownerCookie },
    })
    expect(res.statusCode).toBe(200)
    const graph = res.json() as GraphResponse
    expect(graph.nodes).toHaveLength(4)

    const byPath = new Map(graph.nodes.map((n) => [n.path, n.id]))
    const hasEdge = (a: string, b: string, kind: string) =>
      graph.edges.some(
        (e) =>
          e.kind === kind &&
          ((e.source === byPath.get(a) && e.target === byPath.get(b)) ||
            (e.source === byPath.get(b) && e.target === byPath.get(a))),
      )

    // Extracted from the wikilink.
    expect(hasEdge('projects/apollo', 'people/wernher', 'extracted')).toBe(true)
    // Structural: same type + shared tag.
    expect(hasEdge('people/wernher', 'people/margaret', 'structural')).toBe(true)
    // Semantic: apollo and wernher share heavy vocabulary (rocket/engine/apollo).
    expect(hasEdge('projects/apollo', 'people/wernher', 'semantic')).toBe(true)
    // Communities assigned to every node.
    expect(graph.nodes.every((n) => typeof n.community === 'number')).toBe(true)
  })

  it('filters by type', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/graph?types=people`,
      headers: { cookie: ownerCookie },
    })
    const graph = res.json() as GraphResponse
    expect(graph.nodes).toHaveLength(2)
    expect(graph.nodes.every((n) => n.path.startsWith('people/'))).toBe(true)
  })

  it('is invisible to strangers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/graph`,
      headers: { cookie: strangerCookie },
    })
    expect(res.statusCode).toBe(404)
  })

  it('merged view honors mergeable gate + preference + live access', async () => {
    // Preference set but vault not mergeable → empty merged graph.
    await app.inject({
      method: 'PUT',
      url: `/api/vaults/${vaultId}/graph-preference`,
      headers: { cookie: ownerCookie },
      body: { include: true },
    })
    let merged = (
      await app.inject({ method: 'GET', url: '/api/graph/merged', headers: { cookie: ownerCookie } })
    ).json() as GraphResponse
    expect(merged.nodes).toHaveLength(0)

    // Owner flips mergeable on → nodes appear.
    await app.inject({
      method: 'PATCH',
      url: `/api/vaults/${vaultId}`,
      headers: { cookie: ownerCookie },
      body: { mergeable: true },
    })
    merged = (
      await app.inject({ method: 'GET', url: '/api/graph/merged', headers: { cookie: ownerCookie } })
    ).json() as GraphResponse
    expect(merged.nodes.length).toBeGreaterThan(0)
  })
})

describe('search', () => {
  it('finds notes by keyword with a highlighted snippet', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/search?q=guidance software`,
      headers: { cookie: ownerCookie },
    })
    expect(res.statusCode).toBe(200)
    const results = res.json() as Array<{ path: string; snippet: string }>
    expect(results[0]?.path).toBe('people/margaret')
    expect(results[0]?.snippet).toContain('<b>')
  })

  it('finds conceptually related notes without exact keywords (hybrid)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/search?q=rocket engine`,
      headers: { cookie: ownerCookie },
    })
    const paths = (res.json() as Array<{ path: string }>).map((r) => r.path)
    expect(paths).toContain('projects/apollo')
    expect(paths).toContain('people/wernher')
  })

  it('search everywhere covers accessible vaults only — revocation applies instantly', async () => {
    const reader = await createActiveUser()
    const readerCookie = await loginCookie(app, reader.email)

    // Nothing accessible → nothing found, not even a hint.
    let res = await app.inject({
      method: 'GET',
      url: '/api/search?q=rocket',
      headers: { cookie: readerCookie },
    })
    expect(res.json()).toEqual([])

    const share = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/shares`,
      headers: { cookie: ownerCookie },
      body: { granteeType: 'user', granteeId: reader.id, permission: 'read' },
    })
    const shareId = (share.json() as { id: string }).id
    res = await app.inject({
      method: 'GET',
      url: '/api/search?q=rocket',
      headers: { cookie: readerCookie },
    })
    expect((res.json() as unknown[]).length).toBeGreaterThan(0)

    await app.inject({
      method: 'DELETE',
      url: `/api/vaults/${vaultId}/shares/${shareId}`,
      headers: { cookie: ownerCookie },
    })
    res = await app.inject({
      method: 'GET',
      url: '/api/search?q=rocket',
      headers: { cookie: readerCookie },
    })
    expect(res.json()).toEqual([])
  })
})
