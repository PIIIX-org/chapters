// #426: the MCP `graph` tool's `neighborsOf`, `depth`, `edgeTypes` and
// `limit` do what they say (they were refused as unknown arguments), the
// default answer is the community view (the whole node list only with
// `aggregate: "none"`), and conflicting arguments are refused, never ignored.
// Every case goes through the MCP HTTP path.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { inArray, or } from 'drizzle-orm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { semanticEdges } from '../src/db/schema.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createNote } from '../src/notes/store.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Args = Record<string, unknown>
type Truncated = false | { shown: Record<string, number>; total: Record<string, number | string>; dropped: Record<string, number>; level: string; cursor: string | null; narrow: string[] }
type Answer = Record<string, unknown> & { truncated: Truncated }
interface Node {
  id: string
  path: string
  resourceType: string
  community?: number
  distance?: number
}
interface Edge {
  source: string
  target: string
  kind: string
}
/** An edge row (#558): its ends by name, `in` the vault or repository (the calls span both). */
interface Row {
  from: { path: string; in?: string }
  to: { path: string; in?: string }
  kind: string
}

let app: FastifyInstance
let baseUrl: string
let agent: Client
let vaultId: string
let repoId: string
let cookie: string
const REPO = 'graph-params-repo'
/** Every argument set below is over the vault and the repository together. */
let scope: Args
const idOf: Record<string, string> = {}

async function call(args: Args): Promise<{ isError: boolean; text: string }> {
  resetRateLimits()
  const result = await agent.callTool({ name: 'graph', arguments: { ...scope, ...args } })
  const content = result.content as Array<{ type: string; text?: string }>
  return { isError: result.isError === true, text: content.map((c) => c.text ?? '').join('') }
}

/** One answer within its budget, `truncated` last. */
async function page(args: Args): Promise<Answer> {
  const r = await call(args)
  expect(r.isError, `graph ${JSON.stringify(args)}: ${r.text.slice(0, 300)}`).toBe(false)
  const budget = typeof args.budget_tokens === 'number' ? args.budget_tokens : 2_000
  expect(Math.ceil(r.text.length / 4)).toBeLessThanOrEqual(budget)
  const json = JSON.parse(r.text) as Answer
  expect(Object.keys(json).at(-1)).toBe('truncated')
  return json
}

/** Follows `truncated.cursor` to the end. */
async function walk(args: Args): Promise<Answer[]> {
  const pages: Answer[] = []
  let cursor: string | null = null
  for (;;) {
    const json = await page({ ...args, ...(cursor ? { cursor } : {}) })
    pages.push(json)
    cursor = json.truncated === false ? null : json.truncated.cursor
    if (cursor === null) return pages
    if (pages.length > 200) throw new Error('graph never reached the last page')
  }
}

async function refused(args: Args, why: RegExp): Promise<void> {
  const r = await call(args)
  expect(r.isError, `graph ${JSON.stringify(args)}: ${r.text.slice(0, 200)}`).toBe(true)
  expect(r.text).toMatch(why)
}

const nodesOf = (json: Answer) => json.nodes as Node[]
/** The rows as id pairs: notes are keyed by path in `idOf`, files by `file:<path>`. */
const idAt = (end: Row['from']) => (end.in?.startsWith(`${REPO}#`) ? idOf[`file:${end.path}`]! : idOf[end.path]!)
/** An end of a row down the ladder (`in:path`, #558). */
const endAt = (text: string) => {
  const at = text.indexOf(':')
  return idAt({ in: text.slice(0, at), path: text.slice(at + 1) })
}
/** A row, or one down the ladder: `from -> to relation …`, its kind from the relation. */
const edgesOf = (json: Answer): Edge[] =>
  (json.edges as Array<Row | string>).map((r) => {
    if (typeof r !== 'string') return { source: idAt(r.from), target: idAt(r.to), kind: r.kind }
    const [, from, to, relation] = /^(.+?) (?:->|--) (.+?) (link|import|same_\w+|similar)\b/.exec(r)!
    return { source: endAt(from!), target: endAt(to!), kind: relation === 'similar' ? 'semantic' : relation!.startsWith('same_') ? 'structural' : 'extracted' }
  })
const pairKey = (e: Edge) => `${[e.source, e.target].sort().join('|')}:${e.kind}`

/** The whole graph as node list, one page. */
async function fullGraph(args: Args = {}): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const json = await page({ aggregate: 'none', budget_tokens: 25_000, ...args })
  expect(json.truncated).toBe(false)
  return { nodes: nodesOf(json), edges: edgesOf(json) }
}

/** What `neighborsOf` must answer: breadth-first search over the whole graph's edges, then every edge among the nodes reached. */
function expectedNeighborhood(
  full: { nodes: Node[]; edges: Edge[] },
  center: string,
  depth: number,
  keep: (n: Node) => boolean = () => true,
): { distance: Map<string, number>; edges: string[] } {
  const byId = new Map(full.nodes.map((n) => [n.id, n]))
  const ok = (id: string) => id === center || keep(byId.get(id)!)
  const distance = new Map([[center, 0]])
  let frontier = [center]
  for (let d = 1; d <= depth; d++) {
    const next: string[] = []
    for (const id of frontier) {
      for (const e of full.edges) {
        const other = e.source === id ? e.target : e.target === id ? e.source : null
        if (other && ok(other) && !distance.has(other)) {
          distance.set(other, d)
          next.push(other)
        }
      }
    }
    frontier = next
  }
  const edges = full.edges.filter((e) => distance.has(e.source) && distance.has(e.target)).map(pairKey).sort()
  return { distance, edges }
}

const words = ['amber', 'birch', 'cedar', 'delta', 'ember', 'fjord', 'glyph', 'heron', 'indigo', 'jasper']

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'graph params' } })).json<{ id: string }>().id
  repoId = (await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name: REPO, ingestionMethod: 'agent_push' } })).json<{
    id: string
  }>().id
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: 'graph-params-agent', scope: 'account' } })
  agent = new Client({ name: 'graph-params-test', version: '0.0.0' })
  await agent.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } },
    }),
  )
  scope = { vaultId, repositoryId: repoId }

  // Each note its own type (no type group), each body 40 repeats of its own word (no semantic edge
  // from the test embedder: tests run with SEMANTIC_THRESHOLD=0.2, see mcp-response-envelope.test.ts);
  // the one semantic edge is stored below. From p0/c: p1/a out, p2/b in, a→b between two ring-1 nodes,
  // a→d→e→f a chain, b and t share the tag `bridge` (structural), s links to the repository's main file.
  const notes: Array<[string, string, string[]?]> = [
    ['p0/c', '[[p1/a]]'],
    ['p1/a', '[[p3/d]] [[p2/b]]'],
    ['p2/b', '[[p0/c]]', ['bridge']],
    ['p3/d', '[[p4/e]]'],
    ['p4/e', '[[p5/f]]'],
    ['p5/f', ''],
    ['p6/s', `[[repo:${REPO}/src/main.ts]]`],
    ['p7/t', '', ['bridge']],
    ['docs/dup', ''],
  ]
  for (const [i, [path, links, tags]] of notes.entries()) {
    const note = await createNote(vaultId, { path, body: `${`${words[i]} `.repeat(40)}${links}`, ...(tags ? { frontmatter: { tags } } : {}) })
    idOf[path] = note.id
  }
  // main imports util (extracted); main, util and other share the language (structural), main and util the folder.
  const files = [
    { path: 'src/main.ts', content: "import { util } from './util'\nexport const main = util" },
    { path: 'src/util.ts', content: 'export const util = 1' },
    { path: 'lib/other.ts', content: 'export const other = 2' },
    // Same path as the note docs/dup: `neighborsOf: "docs/dup"` names two nodes.
    { path: 'docs/dup', content: 'plain text' },
  ]
  await syncRepositoryFiles(repoId, files, files.map((f) => f.path))
  await flushExtraction()
  await flushEmbeddings()
  const ids = Object.values(idOf)
  const fileRows = await app.inject({ method: 'GET', url: `/api/repositories/${repoId}/files`, headers: { cookie } })
  for (const f of fileRows.json<Array<{ id: string; path: string }>>()) idOf[`file:${f.path}`] = f.id
  ids.push(...files.map((f) => idOf[`file:${f.path}`]!))
  // Only the one semantic edge: p0/c → p6/s.
  await db.delete(semanticEdges).where(or(inArray(semanticEdges.sourceId, ids), inArray(semanticEdges.targetId, ids)))
  await db.insert(semanticEdges).values({ sourceType: 'note', sourceId: idOf['p0/c']!, targetType: 'note', targetId: idOf['p6/s']!, similarity: 0.9 })
}, 120_000)

afterAll(async () => {
  await agent?.close().catch(() => {})
  await app.close()
})

describe('graph: the fixture', () => {
  it('has exactly the edges it was built with', async () => {
    const full = await fullGraph()
    expect(full.nodes).toHaveLength(13)
    const kinds = full.edges.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.kind]: (acc[e.kind] ?? 0) + 1 }), {})
    // extracted: c-a, b-c, a-b, a-d, d-e, e-f, s-main, main-util; structural: b-t, main-util, main-other, util-other; semantic: c-s.
    expect(kinds).toEqual({ extracted: 8, structural: 4, semantic: 1 })
  })
})

describe('graph: the default is the community view (#426)', () => {
  it('without `aggregate` the answer is one node per community; `aggregate: "none"` lists the nodes', async () => {
    const json = await page({ budget_tokens: 25_000 })
    expect(json.aggregated).toBe(true)
    const communities = nodesOf(json) as unknown as Array<{ id: string; size: number }>
    expect(communities.length).toBeGreaterThan(0)
    for (const c of communities) expect(c.id).toMatch(/^community:\d+$/)
    expect(communities.reduce((n, c) => n + c.size, 0)).toBe(13)
    // Largest community first.
    expect(communities.map((c) => c.size)).toEqual([...communities.map((c) => c.size)].sort((a, b) => b - a))
    const full = await fullGraph()
    expect(full.nodes.every((n) => typeof n.path === 'string')).toBe(true)
  })

  it('`community` alone still lists that community’s members', async () => {
    const json = await page({ budget_tokens: 25_000 })
    const first = (json.nodes as Array<{ community: number; size: number }>)[0]!
    const members = await page({ community: first.community, budget_tokens: 25_000 })
    expect(members.aggregated).toBeUndefined()
    expect(nodesOf(members)).toHaveLength(first.size)
  })
})

describe('graph: neighborsOf and depth (#426)', () => {
  it('equals breadth-first search over the whole graph, depth 1 to 3, with the edges among the nodes reached', async () => {
    const full = await fullGraph()
    for (const depth of [1, 2, 3]) {
      const json = await page({ neighborsOf: 'p0/c', depth, budget_tokens: 25_000 })
      expect(json.truncated).toBe(false)
      const want = expectedNeighborhood(full, idOf['p0/c']!, depth)
      expect(Object.fromEntries(nodesOf(json).map((n) => [n.id, n.distance]))).toEqual(Object.fromEntries(want.distance))
      expect(edgesOf(json).map(pairKey).sort()).toEqual(want.edges)
      for (const n of nodesOf(json)) expect(n).not.toHaveProperty('community')
      expect(json.center).toEqual({ id: idOf['p0/c'], path: 'p0/c' })
    }
    // Depth 1 holds the edge between two ring-1 nodes (a→b), depth 3 crosses into the repository.
    const one = await page({ neighborsOf: 'p0/c', budget_tokens: 25_000 })
    expect(nodesOf(one).map((n) => n.path).sort()).toEqual(['p0/c', 'p1/a', 'p2/b', 'p6/s'])
    expect(edgesOf(one).map(pairKey)).toContain(pairKey({ source: idOf['p1/a']!, target: idOf['p2/b']!, kind: 'extracted' }))
    const three = await page({ neighborsOf: 'p0/c', depth: 3, budget_tokens: 25_000 })
    expect(nodesOf(three).map((n) => n.path).sort()).toEqual(['lib/other.ts', 'p0/c', 'p1/a', 'p2/b', 'p3/d', 'p4/e', 'p6/s', 'p7/t', 'src/main.ts', 'src/util.ts'])
  })

  it('takes a node id, a code file and the types/tags filters; the centre is listed first', async () => {
    const full = await fullGraph()
    const byId = await page({ neighborsOf: idOf['p3/d'], depth: 2, budget_tokens: 25_000 })
    const want = expectedNeighborhood(full, idOf['p3/d']!, 2)
    expect(Object.fromEntries(nodesOf(byId).map((n) => [n.id, n.distance]))).toEqual(Object.fromEntries(want.distance))
    expect(nodesOf(byId)[0]!.id).toBe(idOf['p3/d'])

    const code = await page({ neighborsOf: 'src/util.ts', depth: 2, budget_tokens: 25_000 })
    const wantCode = expectedNeighborhood(full, idOf['file:src/util.ts']!, 2)
    expect(Object.fromEntries(nodesOf(code).map((n) => [n.id, n.distance]))).toEqual(Object.fromEntries(wantCode.distance))
    expect(edgesOf(code).map(pairKey).sort()).toEqual(wantCode.edges)
    // Incoming `repo:` link: s reaches main from the repository side too.
    expect(nodesOf(code).map((n) => n.path)).toContain('p6/s')

    const typed = await page({ neighborsOf: 'p0/c', depth: 3, types: ['p1', 'p3'], budget_tokens: 25_000 })
    expect(nodesOf(typed).map((n) => n.path).sort()).toEqual(['p0/c', 'p1/a', 'p3/d'])
    const tagged = await page({ neighborsOf: 'p2/b', depth: 3, tags: ['bridge'], budget_tokens: 25_000 })
    expect(nodesOf(tagged).map((n) => n.path).sort()).toEqual(['p2/b', 'p7/t'])
  })

  it('refuses an unknown node and depth outside 1..3 or without neighborsOf; an ambiguous path lists its candidates', async () => {
    await refused({ neighborsOf: 'p9/nowhere' }, /p9\/nowhere/)
    // The note docs/dup and the file docs/dup (#447): both are candidates, the file first (kind order, #1006), either id works.
    expect((await page({ neighborsOf: 'docs/dup' })).candidates).toEqual([
      { path: 'docs/dup', kind: 'code', id: idOf['file:docs/dup'] },
      { path: 'docs/dup', kind: 'note', id: idOf['docs/dup'] },
    ])
    expect(nodesOf(await page({ neighborsOf: idOf['file:docs/dup'] })).map((n) => n.id)).toEqual([idOf['file:docs/dup']])
    await refused({ neighborsOf: 'p0/c', depth: 4 }, /depth/)
    await refused({ neighborsOf: 'p0/c', depth: 0 }, /depth/)
    await refused({ depth: 2 }, /depth.*neighborsOf/)
    await refused({ neighborsOf: 'p0/c', community: 0 }, /neighborsOf.*community|community.*neighborsOf/)
    await refused({ neighborsOf: 'p0/c', aggregate: 'community' }, /neighborsOf.*aggregate|aggregate.*neighborsOf/)
    await refused({ aggregate: 'community', community: 0 }, /aggregate.*community/)
  })
})

describe('graph: edgeTypes (#426)', () => {
  it('keeps only the asked kinds, before the walk and before assembly', async () => {
    const full = await fullGraph()
    for (const kinds of [['extracted'], ['structural'], ['semantic'], ['extracted', 'semantic']]) {
      const only = await fullGraph({ edgeTypes: kinds })
      expect(only.nodes).toHaveLength(13)
      expect(only.edges.map(pairKey).sort()).toEqual(full.edges.filter((e) => kinds.includes(e.kind)).map(pairKey).sort())
      const local = await page({ neighborsOf: 'p0/c', depth: 3, edgeTypes: kinds, budget_tokens: 25_000 })
      const want = expectedNeighborhood({ nodes: full.nodes, edges: full.edges.filter((e) => kinds.includes(e.kind)) }, idOf['p0/c']!, 3)
      expect(Object.fromEntries(nodesOf(local).map((n) => [n.id, n.distance]))).toEqual(Object.fromEntries(want.distance))
      expect(edgesOf(local).map(pairKey).sort()).toEqual(want.edges)
    }
    // Without semantic edges p6/s is not reached from p0/c, and so neither is the repository.
    const extracted = await page({ neighborsOf: 'p0/c', depth: 3, edgeTypes: ['extracted'], budget_tokens: 25_000 })
    expect(nodesOf(extracted).map((n) => n.path).sort()).toEqual(['p0/c', 'p1/a', 'p2/b', 'p3/d', 'p4/e'])
    // The community view is computed over the kept edges: with the one semantic edge, p0/c and p6/s pair up and every other node is alone.
    const semantic = await page({ edgeTypes: ['semantic'], budget_tokens: 25_000 })
    expect((nodesOf(semantic) as unknown as Array<{ size: number }>).map((c) => c.size)).toEqual([2, ...Array.from({ length: 11 }, () => 1)])
    await refused({ edgeTypes: ['similar'] }, /edgeTypes/)
    await refused({ edgeTypes: [] }, /edgeTypes/)
  })
})

describe('graph: limit (#426)', () => {
  it('neighborsOf: the nearest `limit` nodes (distance, then path) and the edges among them; the total is ">limit"', async () => {
    const json = await page({ neighborsOf: 'p0/c', depth: 3, limit: 4, budget_tokens: 25_000 })
    expect(nodesOf(json).map((n) => n.path)).toEqual(['p0/c', 'p1/a', 'p2/b', 'p6/s'])
    const kept = new Set(nodesOf(json).map((n) => n.id))
    expect(edgesOf(json).every((e) => kept.has(e.source) && kept.has(e.target))).toBe(true)
    expect(edgesOf(json).map(pairKey).sort()).toEqual(
      [
        { source: idOf['p0/c']!, target: idOf['p1/a']!, kind: 'extracted' },
        { source: idOf['p0/c']!, target: idOf['p2/b']!, kind: 'extracted' },
        { source: idOf['p1/a']!, target: idOf['p2/b']!, kind: 'extracted' },
        { source: idOf['p0/c']!, target: idOf['p6/s']!, kind: 'semantic' },
      ]
        .map(pairKey)
        .sort(),
    )
    expect(json.truncated).toMatchObject({ shown: { nodes: 4, edges: 4 }, total: { nodes: '>4', edges: 4 }, dropped: { nodes: 0, edges: 0 }, cursor: null })
    // A limit the neighbourhood fits in leaves nothing out.
    const all = await page({ neighborsOf: 'p0/c', depth: 3, limit: 10, budget_tokens: 25_000 })
    expect(nodesOf(all)).toHaveLength(10)
    expect(all.truncated).toBe(false)
  })

  it('node list: the `limit` best-connected nodes (degree, then path); communities: the largest', async () => {
    const json = await page({ aggregate: 'none', limit: 3, budget_tokens: 25_000 })
    // Degrees: src/main.ts 4; p0/c, p1/a, p2/b and src/util.ts 3.
    expect(nodesOf(json).map((n) => n.path)).toEqual(['src/main.ts', 'p0/c', 'p1/a'])
    expect(edgesOf(json).map(pairKey)).toEqual([pairKey({ source: idOf['p0/c']!, target: idOf['p1/a']!, kind: 'extracted' })])
    expect(json.truncated).toMatchObject({ total: { nodes: '>3', edges: 1 }, cursor: null })
    // The drill-down hint names the best-connected node by id: a path can name a note and a file.
    expect((json.truncated as { narrow: string[] }).narrow[0]).toBe(`neighborsOf: "${idOf['file:src/main.ts']}"`)

    const all = await page({ budget_tokens: 25_000 })
    const top = await page({ limit: 1, budget_tokens: 25_000 })
    expect(nodesOf(top)).toEqual([nodesOf(all)[0]])
    expect(edgesOf(top)).toEqual([])
    expect(top.truncated).toMatchObject({ total: { nodes: '>1' } })
  })

  it('budget interplay: a small budget pages within the limit; every node and edge comes once', async () => {
    const whole = await page({ neighborsOf: 'p0/c', depth: 3, budget_tokens: 25_000 })
    const pages = await walk({ neighborsOf: 'p0/c', depth: 3, budget_tokens: 400 })
    expect(pages.length).toBeGreaterThan(1)
    expect(pages.flatMap((p) => nodesOf(p).map((n) => n.id)).sort()).toEqual(nodesOf(whole).map((n) => n.id).sort())
    expect(pages.flatMap((p) => edgesOf(p).map(pairKey)).sort()).toEqual(edgesOf(whole).map(pairKey).sort())

    // Down the ladder an edge row is one line, `from -> to relation …` (#558): six nodes and their edges fit 300 tokens, so eight at 256 page.
    const limited = await walk({ neighborsOf: 'p0/c', depth: 3, limit: 8, budget_tokens: 256 })
    expect(limited.length).toBeGreaterThan(1)
    expect(limited[0]!.truncated).toMatchObject({ total: { nodes: '>8' }, cursor: expect.any(String) })
    const shownNodes = limited.flatMap((p) => nodesOf(p).map((n) => n.id))
    expect(shownNodes).toHaveLength(8)
    expect(new Set(shownNodes).size).toBe(8)
    const kept = new Set(shownNodes)
    for (const e of limited.flatMap(edgesOf)) expect([e.source, e.target].every((id) => kept.has(id)), JSON.stringify(e)).toBe(true)
    // A cursor is bound to its arguments: another limit refuses it.
    await refused({ neighborsOf: 'p0/c', depth: 3, limit: 7, budget_tokens: 256, cursor: (limited[0]!.truncated as { cursor: string }).cursor }, /invalid cursor/)
  })
})

describe('graph: structural groups over the cap (#426)', () => {
  it('are skipped around neighborsOf as in the whole graph, and reported in cappedGroups', async () => {
    const crowdVault = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'graph crowd' } })).json<{ id: string }>().id
    // 51 notes of one type and one tag (both groups over the cap of 50); two of them also share the tag `pair`.
    // Two more, `a-solo/x` and `a-solo/y`, share a type and a tag of their own (one structural edge) and sort first.
    const ids: string[] = []
    for (let i = 0; i < 51; i++) {
      const tags = i < 2 ? ['crowd', 'pair'] : ['crowd']
      ids.push((await createNote(crowdVault, { path: `crowd/n-${String(i).padStart(2, '0')}`, body: `Crowd ${i}.`, frontmatter: { tags } })).id)
    }
    for (const name of ['x', 'y']) ids.push((await createNote(crowdVault, { path: `a-solo/${name}`, body: `Solo ${name}.`, frontmatter: { tags: ['duo'] } })).id)
    await flushEmbeddings()
    await db.delete(semanticEdges).where(or(inArray(semanticEdges.sourceId, ids), inArray(semanticEdges.targetId, ids)))
    const only = { vaultId: crowdVault, repositoryId: undefined, budget_tokens: 25_000 }
    const whole = await page({ ...only, aggregate: 'none' })
    expect([...(whole.cappedGroups as string[])].sort()).toEqual(['tag:crowd', 'type:crowd'])
    expect(edgesOf(whole).map((e) => e.kind)).toEqual(['structural', 'structural'])
    const local = await page({ ...only, neighborsOf: 'crowd/n-00', depth: 3 })
    expect(nodesOf(local).map((n) => n.path)).toEqual(['crowd/n-00', 'crowd/n-01'])
    expect(edgesOf(local)).toHaveLength(1)
    expect(local.cappedGroups).toEqual(['tag:crowd', 'type:crowd'])

    // Under `limit`, the node views name only the skipped groups a listed node belongs to, as `neighborsOf` does.
    const solo = await page({ ...only, aggregate: 'none', limit: 2 })
    expect(nodesOf(solo).map((n) => n.path)).toEqual(['a-solo/x', 'a-solo/y'])
    expect(solo.cappedGroups).toEqual([])
    const three = await page({ ...only, aggregate: 'none', limit: 3 })
    expect(nodesOf(three).map((n) => n.path)).toEqual(['a-solo/x', 'a-solo/y', 'crowd/n-00'])
    expect([...(three.cappedGroups as string[])].sort()).toEqual(['tag:crowd', 'type:crowd'])
    // The community view keeps the whole graph's: every node went into its communities, whatever `limit` lists.
    const communities = await page({ ...only, limit: 1 })
    expect([...(communities.cappedGroups as string[])].sort()).toEqual(['tag:crowd', 'type:crowd'])
  })
})
