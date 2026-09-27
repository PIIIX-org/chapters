import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { findShortestPath, type GraphEdge, type GraphNode, type VaultGraph } from '../src/graph/assemble.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
let userCookie: string
let strangerCookie: string
let vaultId: string

const mockNodes: GraphNode[] = [
  {
    id: 'n1',
    resourceType: 'note',
    resourceId: 'v1',
    path: 'concepts/auth',
    type: 'concept',
    tags: ['security'],
    timestamp: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    community: 0,
  },
  {
    id: 'n2',
    resourceType: 'code',
    resourceId: 'r1',
    path: 'server/src/auth/jwt.ts',
    type: 'ts',
    tags: [],
    timestamp: null,
    updatedAt: null,
    community: 0,
  },
  {
    id: 'n3',
    resourceType: 'note',
    resourceId: 'v1',
    path: 'designs/session-model',
    type: 'spec',
    tags: ['auth'],
    timestamp: '2026-09-02T00:00:00Z',
    updatedAt: '2026-09-02T00:00:00Z',
    community: 0,
  },
  {
    id: 'n4',
    resourceType: 'note',
    resourceId: 'v1',
    path: 'isolated/island',
    type: 'misc',
    tags: [],
    timestamp: '2026-09-03T00:00:00Z',
    updatedAt: '2026-09-03T00:00:00Z',
    community: 1,
  },
]

const mockEdges: GraphEdge[] = [
  { source: 'n1', target: 'n2', kind: 'extracted' },
  { source: 'n2', target: 'n3', kind: 'structural' },
]

const mockGraph: VaultGraph = {
  nodes: mockNodes,
  edges: mockEdges,
  cappedGroups: [],
}

beforeAll(async () => {
  app = await buildApp()
  await app.ready()

  const user = await createActiveUser()
  const stranger = await createActiveUser()
  userCookie = await loginCookie(app, user.email)
  strangerCookie = await loginCookie(app, stranger.email)

  const vaultRes = await app.inject({
    method: 'POST',
    url: '/api/vaults',
    headers: { cookie: userCookie },
    body: { name: 'Pathfinding Vault' },
  })
  vaultId = (vaultRes.json() as { id: string }).id

  await app.inject({
    method: 'PATCH',
    url: `/api/vaults/${vaultId}`,
    headers: { cookie: userCookie },
    body: { mergeable: true },
  })
  await app.inject({
    method: 'PUT',
    url: `/api/vaults/${vaultId}/graph-preference`,
    headers: { cookie: userCookie },
    body: { include: true },
  })

  // Create two linked notes
  await app.inject({
    method: 'POST',
    url: `/api/vaults/${vaultId}/notes`,
    headers: { cookie: userCookie },
    body: { type: 'concepts', name: 'alpha', body: 'Connects to [[concepts/beta]].' },
  })
  await app.inject({
    method: 'POST',
    url: `/api/vaults/${vaultId}/notes`,
    headers: { cookie: userCookie },
    body: { type: 'concepts', name: 'beta', body: 'Target note.' },
  })
  await app.inject({
    method: 'POST',
    url: `/api/vaults/${vaultId}/notes`,
    headers: { cookie: userCookie },
    body: { type: 'concepts', name: 'gamma', body: 'Unconnected note.' },
  })
})

afterAll(async () => {
  await app.close()
})

describe('findShortestPath algorithm', () => {
  it('finds direct 1-hop path between nodes', () => {
    const res = findShortestPath(mockGraph, 'n1', 'n2')
    expect(res.found).toBe(true)
    expect(res.distance).toBe(1)
    expect(res.nodes.map((n) => n.id)).toEqual(['n1', 'n2'])
    expect(res.edges.length).toBe(1)
    expect(res.edges[0]?.kind).toBe('extracted')
  })

  it('finds multi-hop path across notes and code', () => {
    const res = findShortestPath(mockGraph, 'n1', 'n3')
    expect(res.found).toBe(true)
    expect(res.distance).toBe(2)
    expect(res.nodes.map((n) => n.id)).toEqual(['n1', 'n2', 'n3'])
    expect(res.edges.length).toBe(2)
    expect(res.edges.map((e) => e.kind)).toEqual(['extracted', 'structural'])
  })

  it('returns found: true and distance: 0 when source === target', () => {
    const res = findShortestPath(mockGraph, 'n1', 'n1')
    expect(res.found).toBe(true)
    expect(res.distance).toBe(0)
    expect(res.nodes.length).toBe(1)
    expect(res.edges.length).toBe(0)
  })

  it('returns found: false when no connecting path exists', () => {
    const res = findShortestPath(mockGraph, 'n1', 'n4')
    expect(res.found).toBe(false)
    expect(res.distance).toBe(-1)
    expect(res.nodes.length).toBe(0)
    expect(res.edges.length).toBe(0)
  })

  it('returns found: false when node IDs do not exist', () => {
    const res = findShortestPath(mockGraph, 'n1', 'nonexistent')
    expect(res.found).toBe(false)
    expect(res.distance).toBe(-1)
  })
})

describe('Graph Pathfinding API routes', () => {
  it('GET /api/vaults/:id/graph/path returns shortest path for authorized user', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/graph/path?source=concepts/alpha&target=concepts/beta`,
      headers: { cookie: userCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as ReturnType<typeof findShortestPath>
    expect(body.found).toBe(true)
    expect(body.distance).toBe(1)
    expect(body.nodes.length).toBe(2)
    expect(body.nodes[0]?.path).toBe('concepts/alpha')
    expect(body.nodes[1]?.path).toBe('concepts/beta')
  })

  it('GET /api/vaults/:id/graph/path returns 404 for stranger', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/graph/path?source=concepts/alpha&target=concepts/beta`,
      headers: { cookie: strangerCookie },
    })
    expect(res.statusCode).toBe(404)
  })

  it('GET /api/vaults/:id/graph/path reports not found when node missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/graph/path?source=concepts/alpha&target=missing/note`,
      headers: { cookie: userCookie },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toHaveProperty('error')
  })

  it('GET /api/graph/merged/path returns path in merged graph', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/graph/merged/path?source=concepts/alpha&target=concepts/beta',
      headers: { cookie: userCookie },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as ReturnType<typeof findShortestPath>
    expect(body.found).toBe(true)
    expect(body.distance).toBe(1)
  })
})
