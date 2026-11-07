// #472: the REST backlinks say where each note links (`links`: `path#La` and the paragraph or line), the REST local graph
// is the walk MCP `graph` makes in SQL (nearest first, then by path), and `read_note` names the code references of a note
// that no longer hold (`drift`), only when there are any.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createNote } from '../src/notes/store.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
let cookie: string
let vaultId: string
let agent: Client

async function call(tool: string, args: Record<string, unknown>) {
  resetRateLimits()
  const result = await agent.callTool({ name: tool, arguments: args })
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
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: 'ngrd', scope: 'account' } })
  agent = new Client({ name: 'ngrd', version: '0.0.0' })
  await agent.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${minted.json().token}` } } }))
}, 120_000)

afterAll(async () => {
  await agent.close().catch(() => {})
  await app.close()
})

describe('REST backlinks with lines (#472)', () => {
  it('each linking note lists its links, one per line, with the paragraph', async () => {
    const backlinks = (await get(`/api/vaults/${vaultId}/backlinks/docs/centre`)) as Array<{ path: string; links: Array<{ location: string; context: string | null }> }>
    expect(backlinks.map((b) => b.path)).toEqual(['docs/alpha', 'docs/mid'])
    expect(backlinks[0]!.links).toEqual([{ location: expect.stringMatching(/^docs\/alpha#L\d+$/), context: 'Alpha links to [[docs/centre]] once.' }])
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
      ['docs/zeta', 1],
    ])
    expect(rest.nodes.filter((n) => n.isCenter).map((n) => n.path)).toEqual(['docs/centre'])
    const mcp = await call('graph', { vaultId, neighborsOf: 'docs/centre', edgeTypes: ['extracted', 'semantic'] })
    expect((mcp.nodes as Array<{ path: string }>).map((n) => n.path)).toEqual(rest.nodes.map((n) => n.path))
    const extracted = (rest.edges as Array<{ source: string; target: string; kind: string }>).filter((e) => e.kind === 'extracted')
    const byId = new Map((rest.nodes as Array<{ id: string; path: string }>).map((n) => [n.id, n.path]))
    expect(extracted.map((e) => `${byId.get(e.source)}>${byId.get(e.target)}`).sort()).toEqual(['docs/alpha>docs/centre', 'docs/centre>docs/zeta', 'docs/mid>docs/centre'])
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
  })
})
