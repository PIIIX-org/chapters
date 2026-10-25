// #1006: the same notes and files give the same `graph` answer in any
// database. Two accounts build one vault and one repository: world B adds
// the notes and files in the reverse order of world A, and every note and
// file id is assigned so that B's ids sort in the reverse order of A's
// (`rankedId`). Imports resolve in both (one push per world: #1008 is not
// this test's), and the stored semantic rows are replaced by fixed ones per
// content, each stored in the opposite direction in B (#1007 is not this
// test's either). So the worlds differ only in ids, insertion order and the
// stored direction of an undirected row; once ids and times are masked,
// every graph answer must be byte-identical.
import type * as Crypto from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { eq, inArray, or } from 'drizzle-orm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { notes, repositoryFiles, semanticEdges } from '../src/db/schema.js'
import { buildGraph } from '../src/graph/assemble.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createNote } from '../src/notes/store.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
import { createActiveUser, loginCookie } from './helpers.js'

// createNote takes its id from `randomUUID()`: the next one is queued here before each call.
const queuedIds = vi.hoisted(() => [] as string[])
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof Crypto>()
  return { ...actual, randomUUID: () => queuedIds.shift() ?? actual.randomUUID() }
})
const { randomUUID } = await vi.importActual<typeof Crypto>('node:crypto')

/** A fresh id whose first 8 hex digits are `rank`: ids sort by rank (Postgres and JS alike). */
const rankedId = (rank: number): string => `${rank.toString(16).padStart(8, '0')}${randomUUID().slice(8)}`

const VAULT = 'content order vault'
const REPO = 'content-order-repo'
/** Keys whose values are per-database times. */
const TIME_KEYS = ['updatedAt', 'lastActivity', 'timestamp']

// Two clusters (a note's type is its folder: `alpha`, `beta`) joined by one
// link and one tag, a hub, and a note and a file sharing the path
// `docs/plan` (one link each from the hub: the same degree and distance, so
// only their kind tells them apart).
const NOTES: Array<{ path: string; tags?: string[]; body: string }> = [
  { path: 'index', body: `Start at [[alpha/one]]. The plan: [[docs/plan]], its file [[repo:${REPO}/docs/plan]].\n` },
  { path: 'alpha/one', tags: ['bridge'], body: 'Next [[alpha/two]]; across to [[beta/one]].\n' },
  { path: 'alpha/two', body: 'Then [[alpha/three]].\n' },
  { path: 'alpha/three', body: 'Back to [[alpha/one]].\n' },
  { path: 'docs/plan', body: 'Ship it.\n' },
  { path: 'beta/one', tags: ['bridge'], body: 'Next [[beta/two]].\n' },
  { path: 'beta/two', body: 'Then [[beta/three]].\n' },
  { path: 'beta/three', body: 'Back to [[beta/one]].\n' },
]

const FILES: Array<{ path: string; content: string }> = [
  { path: 'src/a.ts', content: "import { b } from './b'\n\nexport const a = (): number => b() + 1\n" },
  { path: 'src/b.ts', content: 'export const b = (): number => 1\n' },
  { path: 'docs/plan', content: 'Ship it.\n' },
]

/** Fixed semantic rows: [a, b, similarity], stored a→b in world A and b→a in world B. */
const SEMANTIC: Array<[string, string, number]> = [
  ['note:alpha/two', 'note:beta/two', 0.5],
  ['note:alpha/three', 'code:src/b.ts', 0.4],
]

interface World {
  agent: Client
  vaultId: string
  repoId: string
  /** Generated id → its label, longest first. */
  labels: Array<[string, string]>
}

let app: FastifyInstance
let baseUrl: string
let A: World
let B: World

async function buildWorld(name: string, reverse: boolean): Promise<World> {
  const owner = await createActiveUser()
  const cookie = await loginCookie(app, owner.email)
  const vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: VAULT } })).json<{ id: string }>().id
  const repoId = (
    await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name: REPO, ingestionMethod: 'agent_push' } })
  ).json<{ id: string }>().id
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: `content-order-${name}`, scope: 'account' } })
  const agent = new Client({ name: `content-order-${name}`, version: '0.0.0' })
  await agent.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } },
    }),
  )
  /** The id of the `index`-th row of a fixture list: ascending in A, descending in B. */
  const idAt = (index: number) => rankedId(reverse ? 0xffffffff - index : index)
  const inOrder = <T>(rows: T[]) => (reverse ? [...rows].reverse() : rows)

  const idOf = new Map<string, string>()
  for (const n of inOrder(NOTES)) {
    const id = idAt(NOTES.indexOf(n))
    queuedIds.push(id)
    const created = await createNote(vaultId, { path: n.path, body: n.body, ...(n.tags ? { frontmatter: { tags: n.tags } } : {}) })
    if (created.id !== id || queuedIds.length > 0) throw new Error(`${n.path}: createNote did not take the queued id ${id} (got ${created.id})`)
    idOf.set(`note:${n.path}`, id)
  }
  // A file's row is inserted empty under its id, then the one push fills every row (an update keeps the id).
  for (const f of inOrder(FILES)) {
    const id = idAt(FILES.indexOf(f))
    await db.insert(repositoryFiles).values({ id, repositoryId: repoId, path: f.path, content: '', contentHash: '', size: 0 })
    idOf.set(`code:${f.path}`, id)
  }
  await syncRepositoryFiles(repoId, inOrder(FILES), inOrder(FILES).map((f) => f.path))
  await flushExtraction()
  await flushEmbeddings()

  // The semantic rows are fixed per content; only their stored direction follows the world.
  const ids = [...idOf.values()]
  await db.delete(semanticEdges).where(or(inArray(semanticEdges.sourceId, ids), inArray(semanticEdges.targetId, ids)))
  for (const [a, b, similarity] of SEMANTIC) {
    const [from, to] = reverse ? [b, a] : [a, b]
    const end = (key: string) => ({ type: key.slice(0, key.indexOf(':')) as 'note' | 'code', id: idOf.get(key)! })
    await db.insert(semanticEdges).values({ sourceType: end(from).type, sourceId: end(from).id, targetType: end(to).type, targetId: end(to).id, similarity })
  }

  const labels: Array<[string, string]> = [
    [vaultId, '<vault>'],
    [repoId, '<repository>'],
    ...[...idOf].map(([key, id]): [string, string] => [id, `<${key}>`]),
    // Names carry the container's first 8 id characters (`name#1a2b3c4d`).
    [vaultId.slice(0, 8), '<vault8>'],
    [repoId.slice(0, 8), '<repository8>'],
  ]
  labels.sort((x, y) => y[0].length - x[0].length)
  return { agent, vaultId, repoId, labels }
}

/** `raw` with the world's ids replaced by their labels and the values of TIME_KEYS by `<time>`. */
function mask(world: World, raw: string): string {
  let out = raw
  for (const key of TIME_KEYS) out = out.replace(new RegExp(`(\\\\?"${key}\\\\?":\\s*\\\\?")[^"\\\\]+`, 'g'), '$1<time>')
  for (const [id, label] of world.labels) out = out.split(id).join(label)
  return out
}

/** One MCP `graph` answer as it came over the wire, masked. */
async function ask(world: World, args: (w: World) => Record<string, unknown>): Promise<string> {
  resetRateLimits()
  const result = await world.agent.callTool({ name: 'graph', arguments: { budget_tokens: 25_000, ...args(world) } })
  expect(result.isError, JSON.stringify(result.content).slice(0, 300)).not.toBe(true)
  return mask(world, JSON.stringify({ content: result.content, structuredContent: result.structuredContent }))
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  A = await buildWorld('a', false)
  B = await buildWorld('b', true)
  // The precondition: B's note and file ids sort in the reverse order of A's.
  const order = async (w: World) => {
    const label = (id: string) => w.labels.find(([known]) => known === id)![1]
    return [
      (await db.select({ id: notes.id }).from(notes).where(eq(notes.vaultId, w.vaultId)).orderBy(notes.id)).map((r) => label(r.id)),
      (await db.select({ id: repositoryFiles.id }).from(repositoryFiles).where(eq(repositoryFiles.repositoryId, w.repoId)).orderBy(repositoryFiles.id)).map((r) => label(r.id)),
    ]
  }
  expect(await order(B)).toEqual((await order(A)).map((ids) => [...ids].reverse()))
}, 120_000)

afterAll(async () => {
  await A?.agent.close().catch(() => {})
  await B?.agent.close().catch(() => {})
  await app.close()
})

describe('graph answers follow the content, not the ids (#1006)', () => {
  it('the vault community view numbers and lists the communities alike', async () => {
    const args = (w: World) => ({ vaultId: w.vaultId })
    expect(await ask(B, args)).toBe(await ask(A, args))
  })

  it('every node of the vault and the repository: the same order, communities and edge rows', async () => {
    const args = (w: World) => ({ vaultId: w.vaultId, repositoryId: w.repoId, aggregate: 'none' })
    expect(await ask(B, args)).toBe(await ask(A, args))
  })

  it('neighbours: a note and a file at one distance with one path are listed alike', async () => {
    const args = (w: World) => ({ vaultId: w.vaultId, repositoryId: w.repoId, neighborsOf: 'index', depth: 2 })
    expect(await ask(B, args)).toBe(await ask(A, args))
  })

  it('buildGraph: nodes, communities and edges (an undirected edge from its lower end) in content order', async () => {
    const graph = async (w: World) => mask(w, JSON.stringify(await buildGraph({ vaultIds: [w.vaultId], repositoryIds: [w.repoId] })))
    const a = await graph(A)
    expect(await graph(B)).toBe(a)
    // Nodes by path in code-unit order, then kind (`code` before `note`); an undirected edge names the earlier node first.
    const parsed = JSON.parse(a) as { nodes: Array<{ id: string }>; edges: Array<{ source: string; target: string; directed: boolean }> }
    const ids = parsed.nodes.map((n) => n.id)
    expect(ids).toEqual([
      '<note:alpha/one>',
      '<note:alpha/three>',
      '<note:alpha/two>',
      '<note:beta/one>',
      '<note:beta/three>',
      '<note:beta/two>',
      '<code:docs/plan>',
      '<note:docs/plan>',
      '<note:index>',
      '<code:src/a.ts>',
      '<code:src/b.ts>',
    ])
    const undirected = parsed.edges.filter((e) => !e.directed)
    expect(undirected.length).toBeGreaterThan(0)
    for (const e of undirected) expect(ids.indexOf(e.source), `${e.source} - ${e.target}`).toBeLessThan(ids.indexOf(e.target))
  })
})
