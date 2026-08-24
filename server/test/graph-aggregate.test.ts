import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { notes, vaults } from '../src/db/schema.js'
import { COMMUNITY_MEMBER_CAP, buildGraph } from '../src/graph/assemble.js'
import { noteLinks } from '../src/db/schema.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
let cookie: string
let vaultId: string

interface CommunityGraphResponse {
  aggregated?: boolean
  nodes: Array<{
    id: string
    community: number
    size: number
    noteCount: number
    codeCount: number
    lastActivity: string | null
  }>
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

  // apollo/wernher share a type, a wikilink, and vocabulary — one
  // community. grocery has a different type and deliberately unrelated
  // wording so it neither picks up a structural edge (different type)
  // nor a semantic one (fake embedder is bag-of-words; disjoint
  // vocabulary keeps cosine similarity under SEMANTIC_THRESHOLD=0.2 in
  // tests). Timestamps are pinned far apart: createNote auto-stamps
  // `now()` into frontmatter, and three notes created back-to-back land
  // within the same second — those shared ISO date/time tokens alone
  // pushed similarity over threshold and silently reconnected the
  // "unrelated" note, which is exactly the trap this fixture needs to
  // avoid.
  for (const [type, name, body, timestamp] of [
    ['people', 'apollo', 'Rocket engine design. See [[people/wernher]].', '1000-01-01T00:00:00.000Z'],
    ['people', 'wernher', 'Chief rocket engine designer for apollo.', '1000-01-01T00:00:00.000Z'],
    ['tasks', 'grocery', 'Buy milk and coffee beans tomorrow.', '9999-12-31T23:59:59.999Z'],
    // Cross-community wikilink so the aggregated graph has at least one
    // inter-community edge to collapse (see the edge-collapse test below).
    ['tasks', 'escalate', 'Escalate the blocked ticket. See [[people/apollo]].', '9999-12-31T23:59:59.999Z'],
  ] as const) {
    await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/notes`,
      headers: { cookie },
      body: { type, name, body, frontmatter: { type, timestamp } },
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
    ).json() as {
      nodes: Array<{
        id: string
        community: number
        resourceType: 'note' | 'code'
        updatedAt: string | null
      }>
    }
    const total = graph.nodes.reduce((sum, n) => sum + n.size, 0)
    expect(total).toBe(plain.nodes.length)

    // ink-fade inputs: noteCount/codeCount must tile the community exactly,
    // and lastActivity must be the MAX updatedAt among that community's
    // plain-graph members (flipping assemble.ts's `>` to `<` would make it
    // the minimum instead, and this is the only place that would notice).
    for (const c of graph.nodes) {
      const members = plain.nodes.filter((n) => n.community === c.community)
      expect(c.noteCount + c.codeCount).toBe(c.size)
      const expectedLastActivity = members
        .map((m) => m.updatedAt)
        .filter((ts): ts is string => ts !== null)
        .sort()
        .at(-1)
      expect(c.lastActivity).toBe(expectedLastActivity ?? null)
    }
  })

  it('collapses edges between the same community pair into one weighted edge', async () => {
    const graph = (
      await app.inject({
        method: 'GET',
        url: `/api/vaults/${vaultId}/graph?aggregate=community`,
        headers: { cookie },
      })
    ).json() as CommunityGraphResponse
    // Guard against the loop below passing vacuously: the fixture must
    // actually produce at least one aggregated inter-community edge.
    expect(graph.edges.length).toBeGreaterThan(0)
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

describe('community drill-down', () => {
  it('returns only the members of one community', async () => {
    const agg = (
      await app.inject({
        method: 'GET',
        url: `/api/vaults/${vaultId}/graph?aggregate=community`,
        headers: { cookie },
      })
    ).json() as CommunityGraphResponse
    const first = agg.nodes[0]!

    const res = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/graph?community=${first.community}`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    const members = res.json() as { nodes: Array<{ id: string; community: number }>; edges: Array<{ source: string; target: string }> }
    expect(members.nodes).toHaveLength(first.size)
    expect(members.nodes.every((n) => n.community === first.community)).toBe(true)

    // The fixture yields >1 community (see beforeAll), so drill-down must
    // actually exclude nodes — this fails if the community filter is a
    // no-op that returns every node.
    const plain = (
      await app.inject({
        method: 'GET',
        url: `/api/vaults/${vaultId}/graph`,
        headers: { cookie },
      })
    ).json() as { nodes: Array<{ id: string; community: number }> }
    expect(plain.nodes.length).toBeGreaterThan(1) // sanity: more than one candidate node exists
    expect(members.nodes.length).toBeLessThan(plain.nodes.length)
    const outsiders = plain.nodes.filter((n) => n.community !== first.community)
    expect(outsiders.length).toBeGreaterThan(0) // sanity: a different community actually exists
    for (const n of outsiders) expect(members.nodes.some((m) => m.id === n.id)).toBe(false)

    const ids = new Set(members.nodes.map((n) => n.id))
    for (const e of members.edges) {
      expect(ids.has(e.source)).toBe(true)
      expect(ids.has(e.target)).toBe(true)
    }
  })

  it('returns an empty graph for a community that does not exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/graph?community=99999`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { nodes: unknown[] }).nodes).toEqual([])
  })
})

describe('community member cap', () => {
  /**
   * Seeds `count` notes sharing one type with no wikilinks between them.
   * A shared type puts them all in one structural group, but the group
   * exceeds STRUCTURAL_GROUP_CAP (50) so no pairwise edges are drawn —
   * no edges at all means louvain is skipped and every node lands in
   * community 0, which is exactly the fast, link-free fixture the cap
   * test needs.
   */
  async function seedFlatVault(count: number): Promise<{ cookie: string; vaultId: string }> {
    const owner = await createActiveUser()
    const cookie = await loginCookie(app, owner.email)
    const [vault] = await db
      .insert(vaults)
      .values({ name: `Cap vault ${count}`, ownerId: owner.id })
      .returning({ id: vaults.id })
    const vaultId = vault!.id
    await db.insert(notes).values(
      Array.from({ length: count }, (_, i) => ({
        vaultId,
        type: 'flat',
        name: `note-${i}`,
        path: `flat/note-${i}.md`,
        frontmatter: { type: 'flat' },
        body: `note ${i}`,
      })),
    )
    return { cookie, vaultId }
  }

  it('caps a large community at COMMUNITY_MEMBER_CAP and reports the true total', async () => {
    const { cookie, vaultId } = await seedFlatVault(COMMUNITY_MEMBER_CAP + 100)

    const res = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/graph?community=0`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      nodes: Array<{ id: string }>
      edges: Array<{ source: string; target: string }>
      memberTotal?: number
    }
    expect(body.nodes.length).toBe(COMMUNITY_MEMBER_CAP)
    expect(body.memberTotal).toBe(COMMUNITY_MEMBER_CAP + 100)
    const ids = new Set(body.nodes.map((n) => n.id))
    for (const e of body.edges) {
      expect(ids.has(e.source)).toBe(true)
      expect(ids.has(e.target)).toBe(true)
    }

    // Determinism: a repeat request keeps the same newest-first slice.
    const res2 = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/graph?community=0`,
      headers: { cookie },
    })
    const body2 = res2.json() as { nodes: Array<{ id: string }> }
    expect(body2.nodes[0]!.id).toBe(body.nodes[0]!.id)
    expect(body2.nodes.at(-1)!.id).toBe(body.nodes.at(-1)!.id)
  })

  it('does not fire below the cap', async () => {
    const { cookie, vaultId } = await seedFlatVault(5)

    const res = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/graph?community=0`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { nodes: unknown[]; memberTotal?: number }
    expect(body.nodes.length).toBe(5)
    expect(body.memberTotal).toBe(5)
  })
})

describe('merged graph aggregation', () => {
  it('returns aggregated community super-nodes from /graph/merged', async () => {
    // The merged endpoint only includes a vault when the user's graph
    // preference is set to include it AND the vault itself is mergeable.
    await app.inject({
      method: 'PUT',
      url: `/api/vaults/${vaultId}/graph-preference`,
      headers: { cookie },
      body: { include: true },
    })
    await app.inject({
      method: 'PATCH',
      url: `/api/vaults/${vaultId}`,
      headers: { cookie },
      body: { mergeable: true },
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/graph/merged?aggregate=community',
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
  })
})

describe('louvain determinism', () => {
  /**
   * A fixed local PRNG (independent of the one under test) generating a
   * planted-partition graph shaped like the one the whole-slice review
   * reproduced instability on: two groups of `perGroup` nodes, pIn/pOut
   * edge probabilities weak enough that the partition is genuinely
   * ambiguous, not a razor-sharp clique pair. All notes share one type so
   * the structural type-group cap (50) swallows the type-clique entirely —
   * every edge here is a deliberate wikilink, nothing structural leaking in.
   */
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  // These notes are inserted straight into the DB (no matching OKF file on
  // disk, unlike the app's real note-creation path) — fine for buildGraph,
  // which only reads the DB, but the admin instance-backup route walks
  // every vault's notes and reads each one's file from disk (unguarded), so
  // an orphaned vault left behind here 500s that route for every other
  // test file that runs afterward. Deleted (cascades to notes/note_links)
  // as soon as each test is done with it.
  const createdVaultIds: string[] = []
  afterEach(async () => {
    for (const id of createdVaultIds.splice(0)) await db.delete(vaults).where(eq(vaults.id, id))
  })

  async function seedAmbiguousVault(): Promise<{ vaultId: string; noteIds: string[] }> {
    const perGroup = 90
    const pIn = 0.12
    const pOut = 0.06
    const owner = await createActiveUser()
    const [vault] = await db.insert(vaults).values({ name: 'Ambiguous vault', ownerId: owner.id }).returning({ id: vaults.id })
    const vaultId = vault!.id
    createdVaultIds.push(vaultId)
    const total = perGroup * 2
    const rows = await db
      .insert(notes)
      .values(
        Array.from({ length: total }, (_, i) => ({
          vaultId,
          type: 'flat',
          name: `note-${i}`,
          path: `flat/note-${i}.md`,
          frontmatter: { type: 'flat' },
          body: `note ${i}`,
        })),
      )
      .returning({ id: notes.id, path: notes.path })
    const rand = mulberry32(42)
    const links: { sourceNoteId: string; targetPath: string }[] = []
    for (let i = 0; i < total; i++) {
      for (let j = i + 1; j < total; j++) {
        const sameGroup = Math.floor(i / perGroup) === Math.floor(j / perGroup)
        if (rand() < (sameGroup ? pIn : pOut)) {
          links.push({ sourceNoteId: rows[i]!.id, targetPath: rows[j]!.path })
        }
      }
    }
    if (links.length > 0) await db.insert(noteLinks).values(links)
    return { vaultId, noteIds: rows.map((r) => r.id) }
  }

  it('assigns the same community number to every node across repeated buildGraph calls over the same data', async () => {
    const { vaultId } = await seedAmbiguousVault()

    // Sequential, not Promise.all: this mirrors the real client flow (one
    // HTTP round trip, then another) rather than firing a burst of
    // concurrent connections at the shared test database.
    const runs = []
    for (let i = 0; i < 5; i++) runs.push(await buildGraph({ vaultIds: [vaultId], repositoryIds: [] }))
    const first = new Map(runs[0]!.nodes.map((n) => [n.id, n.community]))
    for (const run of runs.slice(1)) {
      const communityById = new Map(run.nodes.map((n) => [n.id, n.community]))
      expect(communityById).toEqual(first)
    }
  })

  it('keeps the community a super-node was tapped from valid for the drill-down request', async () => {
    const { vaultId } = await seedAmbiguousVault()

    // Simulates the real client flow: fetch the aggregated graph (run A,
    // whatever the client renders and lets the user tap), then a second,
    // independent buildGraph call for the drill-down (run B) — exactly
    // what GraphCanvas's `?community=<n>` request does.
    const aggregated = await buildGraph({ vaultIds: [vaultId], repositoryIds: [] }, { aggregate: 'community' })
    const tapped = aggregated.nodes[0]!
    const drillDown = await buildGraph({ vaultIds: [vaultId], repositoryIds: [] }, { community: tapped.community })

    expect(drillDown.nodes.length).toBe(tapped.size)
    expect(drillDown.nodes.every((n) => n.community === tapped.community)).toBe(true)
  })
})
