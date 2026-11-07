// #472: the REST backlinks say where each note links (`links`: `path#La` and the paragraph or line), the REST local graph
// is the walk MCP `graph` makes in SQL (nearest first, then by path), and `read_note` names the code references of a note
// that no longer hold (`drift`), only when there are any.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { sql } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
import { createNote } from '../src/notes/store.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
let cookie: string
let vaultId: string
let agent: Client
let pinned: Client
let reader: Client

async function call(tool: string, args: Record<string, unknown>, who: Client = agent) {
  resetRateLimits()
  const result = await who.callTool({ name: tool, arguments: args })
  return JSON.parse((result.content as Array<{ text?: string }>)[0]!.text!) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
}
const get = async (url: string) => (await app.inject({ method: 'GET', url, headers: { cookie } })).json()

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'ngrd-notes' } })).json().id
  const repoId = (await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name: 'ngrd-repo', ingestionMethod: 'agent_push' } })).json().id
  await syncRepositoryFiles(repoId, [{ path: 'src/live.ts', content: 'export function live() {}\n' }], ['src/live.ts'])
  await flushExtraction()
  // The centre links out to `zeta`; `alpha` and `mid` link in (on two lines for `mid`).
  await createNote(vaultId, { path: 'docs/centre', body: '# Centre\n\nSee [[docs/zeta]].\n' })
  await createNote(vaultId, { path: 'docs/zeta', body: 'Zeta.\n' })
  await createNote(vaultId, { path: 'docs/alpha', body: 'Alpha links to [[docs/centre]] once.\n' })
  await createNote(vaultId, { path: 'docs/mid', body: 'First [[docs/centre]].\n\nSecond [[docs/centre]] here.\n' })
  await createNote(vaultId, { path: 'docs/code-ok', body: 'Code: [[repo:ngrd-repo/src/live.ts]].\n' })
  await createNote(vaultId, { path: 'docs/code-gone', body: 'Code: [[repo:ngrd-repo/src/gone.ts]] and [[repo:ngrd-repo/src/live.ts#missingSymbol]].\n' })
  // Linked by a short name and with `.md` (as written, not as the note's path), a second hop, a prose `code:` that is no link,
  // a changed hash recorded in `sources`, and a hub of 55 notes for the node cap.
  await createNote(vaultId, { path: 'docs/short', body: 'Short: [[centre]].\n' })
  await createNote(vaultId, { path: 'docs/slash', body: 'Slash: [[/docs/centre]].\n' })
  await createNote(vaultId, { path: 'docs/withmd', body: 'With md: [[docs/centre.md]].\n' })
  await createNote(vaultId, { path: 'docs/outer', body: 'Out by name: [[zeta]].\n' })
  await createNote(vaultId, { path: 'docs/deep', body: 'Two hops: [[docs/zeta]].\n' })
  await createNote(vaultId, { path: 'docs/prose', body: 'The barcode: 12345 and a decode: step.\n' })
  await createNote(vaultId, { path: 'docs/code-hash', frontmatter: { sources: [{ resource: 'repo:ngrd-repo/src/live.ts', hash: 'deadbeefdeadbeef' }] }, body: 'Hash recorded.\n' })
  await createNote(vaultId, { path: 'hub/hubcentre', body: 'Hub.\n' })
  for (let i = 0; i < 55; i++) await createNote(vaultId, { path: `hub/n${String(i).padStart(2, '0')}`, body: `Link [[hub/hubcentre]] ${i}.\n` })
  // The stub embedder makes short notes similar: the graph cases below are about links, so the similarity edges go.
  await flushEmbeddings()
  await db.execute(sql`DELETE FROM semantic_edges`)
  const mint = async (body: Record<string, unknown>, as = cookie) => {
    const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie: as }, body })
    const client = new Client({ name: 'ngrd', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${minted.json().token}` } } }))
    return client
  }
  agent = await mint({ name: 'ngrd', scope: 'account' })
  pinned = await mint({ name: 'ngrd-pinned', scope: 'vault', vaultId })
  // A reader of the vault with no access to the repository its notes cite.
  const other = await createActiveUser()
  const otherCookie = await loginCookie(app, other.email)
  await app.inject({ method: 'POST', url: `/api/vaults/${vaultId}/shares`, headers: { cookie }, body: { granteeType: 'user', granteeId: other.id, permission: 'read' } })
  reader = await mint({ name: 'ngrd-reader', scope: 'account' }, otherCookie)
}, 120_000)

afterAll(async () => {
  await agent.close().catch(() => {})
  await pinned.close().catch(() => {})
  await reader.close().catch(() => {})
  await app.close()
})

describe('REST backlinks with lines (#472)', () => {
  it('each linking note lists its links, one per line, with the paragraph', async () => {
    const backlinks = (await get(`/api/vaults/${vaultId}/backlinks/docs/centre`)) as Array<{ path: string; links: Array<{ location: string; context: string | null }> }>
    expect(backlinks.map((b) => b.path)).toEqual(['docs/alpha', 'docs/mid', 'docs/short', 'docs/slash', 'docs/withmd'])
    expect(backlinks[0]!.links).toEqual([{ location: expect.stringMatching(/^docs\/alpha#L\d+$/), context: 'Alpha links to [[docs/centre]] once.' }])
    // Linked as `[[centre]]` and `[[docs/centre.md]]`: listed with their lines too.
    expect(backlinks[2]!.links.map((l) => l.context)).toEqual(['Short: [[centre]].'])
    expect(backlinks[3]!.links.map((l) => l.context)).toEqual(['Slash: [[/docs/centre]].'])
    expect(backlinks[4]!.links.map((l) => l.context)).toEqual(['With md: [[docs/centre.md]].'])
    // Every note listed has its lines: one resolver for the list and the lines.
    expect(backlinks.every((b) => b.links.length > 0)).toBe(true)
    expect(backlinks[1]!.links.map((l) => l.context)).toEqual(['First [[docs/centre]].', 'Second [[docs/centre]] here.'])
    expect(backlinks[1]!.links[0]!.location).not.toBe(backlinks[1]!.links[1]!.location)
  })
})

describe('REST local graph from the SQL walk (#472)', () => {
  it('lists the nearest notes first, ties by path, as MCP graph neighborsOf does', async () => {
    const rest = (await get(`/api/vaults/${vaultId}/local-graph/docs/centre`)) as { center: { path: string }; nodes: Array<{ id: string; path: string; depth: number; isCenter: boolean }>; edges: unknown[] }
    expect(rest.center.path).toBe('docs/centre')
    expect(rest.nodes.map((n) => [n.path, n.depth])).toEqual([
      ['docs/centre', 0],
      ['docs/alpha', 1],
      ['docs/mid', 1],
      ['docs/short', 1],
      ['docs/slash', 1],
      ['docs/withmd', 1],
      ['docs/zeta', 1],
    ])
    expect(rest.nodes.filter((n) => n.isCenter).map((n) => n.path)).toEqual(['docs/centre'])
    const mcp = await call('graph', { vaultId, neighborsOf: 'docs/centre', edgeTypes: ['extracted', 'semantic'] })
    expect((mcp.nodes as Array<{ path: string }>).map((n) => n.path)).toEqual(rest.nodes.map((n) => n.path))
    const extracted = (rest.edges as Array<{ source: string; target: string; kind: string }>).filter((e) => e.kind === 'extracted')
    const byId = new Map((rest.nodes as Array<{ id: string; path: string }>).map((n) => [n.id, n.path]))
    expect(extracted.map((e) => `${byId.get(e.source)}>${byId.get(e.target)}`).sort()).toEqual(['docs/alpha>docs/centre', 'docs/centre>docs/zeta', 'docs/mid>docs/centre', 'docs/short>docs/centre', 'docs/slash>docs/centre', 'docs/withmd>docs/centre'])
  })
})

describe('the whole graph resolves links by path, `.md` or name too (#472)', () => {
  it('graph aggregate none has the edges of the short-name, slash and .md links', async () => {
    const all = await call('graph', { vaultId, aggregate: 'none', edgeTypes: ['extracted'], budget_tokens: 25_000 })
    const edges = (all.edges as Array<{ from: { path: string }; to: { path: string } }>).map((e) => `${e.from.path}>${e.to.path}`)
    for (const from of ['short', 'slash', 'withmd']) expect(edges, from).toContain(`docs/${from}>docs/centre`)
    expect(edges).toContain('docs/outer>docs/zeta')
  })
})

describe('REST local graph depth and cap (#472)', () => {
  it('depth 2 reaches the second hop, with a name-linked note on the way; depth 1 does not', async () => {
    const one = (await get(`/api/vaults/${vaultId}/local-graph/docs/centre`)) as { nodes: Array<{ path: string; depth: number }> }
    expect(one.nodes.map((n) => n.path)).not.toContain('docs/deep')
    const two = (await get(`/api/vaults/${vaultId}/local-graph/docs/centre?depth=2`)) as { nodes: Array<{ path: string; depth: number }> }
    expect(two.nodes.filter((n) => n.depth === 2).map((n) => n.path)).toEqual(['docs/deep', 'docs/outer'])
  })

  it('keeps the nearest 50 nodes of a hub of 55', async () => {
    const hub = (await get(`/api/vaults/${vaultId}/local-graph/hub/hubcentre`)) as { nodes: Array<{ path: string; depth: number }> }
    expect(hub.nodes).toHaveLength(50)
    expect(hub.nodes[0]).toMatchObject({ path: 'hub/hubcentre', depth: 0 })
    expect(hub.nodes.slice(1).map((n) => n.path)).toEqual(Array.from({ length: 49 }, (_, i) => `hub/n${String(i).padStart(2, '0')}`))
  })
})

describe('read_note names the references that no longer hold (#472)', () => {
  it('a note with a missing file and a missing symbol has `drift`; one whose references hold, and one without any, has none', async () => {
    const gone = await call('read_note', { vaultId, path: 'docs/code-gone' })
    expect(gone.drift).toEqual([
      { resource: 'repo:ngrd-repo/src/gone.ts', kind: 'deleted_file', detail: expect.stringContaining('src/gone.ts') },
      { resource: 'repo:ngrd-repo/src/live.ts#missingSymbol', kind: 'missing_symbol', detail: expect.stringContaining('missingSymbol') },
    ])
    expect((await call('read_note', { vaultId, path: 'docs/code-ok' })).drift).toBeUndefined()
    expect((await call('read_note', { vaultId, path: 'docs/centre' })).drift).toBeUndefined()
    // Prose that merely contains `code:` is no reference.
    expect((await call('read_note', { vaultId, path: 'docs/prose' })).drift).toBeUndefined()
  })

  it('a hash recorded in `sources` that changed is `hash_mismatch`', async () => {
    const note = await call('read_note', { vaultId, path: 'docs/code-hash' })
    expect(note.drift).toEqual([{ resource: 'repo:ngrd-repo/src/live.ts', kind: 'hash_mismatch', detail: expect.stringContaining('deadbeef') }])
  })

  it('a reader of the vault without access to the repository gets no drift for it', async () => {
    const note = await call('read_note', { vaultId, path: 'docs/code-gone' }, reader)
    expect(note.path).toBe('docs/code-gone')
    expect(note.drift).toBeUndefined()
  })

  it('a vault-pinned connection is told nothing about repositories', async () => {
    const note = await call('read_note', { vaultId, path: 'docs/code-gone' }, pinned)
    expect(note.path).toBe('docs/code-gone')
    expect(note.drift).toBeUndefined()
  })
})
