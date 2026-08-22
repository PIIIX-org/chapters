import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
let cookie: string
let vaultId: string

interface CommunityGraphResponse {
  aggregated?: boolean
  nodes: Array<{ id: string; community: number; size: number; lastActivity: string | null }>
  edges: Array<{ source: string; target: string; weight: number }>
}

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
      body: { name: 'Aggregate vault' },
    })).json() as { id: string }
  ).id

  for (const [name, body] of [
    ['apollo', 'Rocket engine design. See [[people/wernher]].'],
    ['wernher', 'Chief rocket engine designer for apollo.'],
    ['grocery', 'Buy milk and coffee beans tomorrow.'],
  ] as const) {
    await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/notes`,
      headers: { cookie },
      body: { type: 'notes', name, body, frontmatter: { type: 'notes' } },
    })
  }
  await flushEmbeddings()
})

afterAll(async () => app.close())

describe('community-aggregated graph', () => {
  it('returns community super-nodes instead of individual notes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/graph?aggregate=community`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    const graph = res.json() as CommunityGraphResponse
    expect(graph.aggregated).toBe(true)
    expect(graph.nodes.length).toBeGreaterThan(0)
    for (const n of graph.nodes) {
      expect(n.id).toMatch(/^community:\d+$/)
      expect(n.size).toBeGreaterThan(0)
    }
    // Member counts must account for every node in the unaggregated graph.
    const plain = (
      await app.inject({
        method: 'GET',
        url: `/api/vaults/${vaultId}/graph`,
        headers: { cookie },
      })
    ).json() as { nodes: unknown[] }
    const total = graph.nodes.reduce((sum, n) => sum + n.size, 0)
    expect(total).toBe(plain.nodes.length)
  })

  it('collapses edges between the same community pair into one weighted edge', async () => {
    const graph = (
      await app.inject({
        method: 'GET',
        url: `/api/vaults/${vaultId}/graph?aggregate=community`,
        headers: { cookie },
      })
    ).json() as CommunityGraphResponse
    const seen = new Set<string>()
    for (const e of graph.edges) {
      const key = [e.source, e.target].sort().join('|')
      expect(seen.has(key)).toBe(false)
      seen.add(key)
      expect(e.weight).toBeGreaterThan(0)
      expect(e.source).not.toBe(e.target) // self-loops are dropped
    }
  })

  it('is unchanged without the parameter', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/graph`,
      headers: { cookie },
    })
    const graph = res.json() as CommunityGraphResponse
    expect(graph.aggregated).toBeUndefined()
    expect(graph.nodes.every((n) => !n.id.startsWith('community:'))).toBe(true)
  })
})
