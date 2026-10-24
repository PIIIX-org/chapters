// #447: graph lookups (`graph`'s `neighborsOf`, `find_graph_path`'s ends,
// the REST path routes) take a node id, a path, part of a path or a name.
// One match resolves; several are a successful answer listing them as
// `candidates` (shorter path first, then path; at most 10); none is
// NOT_FOUND with nearby paths as `suggestions` (ADR-004 §2.7). Candidates
// and suggestions come only from what the caller can read: another
// account's notes never show. Every MCP case goes through the HTTP path.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createNote } from '../src/notes/store.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Args = Record<string, unknown>
interface Candidate {
  path: string
  kind: string
  id: string
}
interface ErrorBody {
  error: { code: string; message: string; retryable: boolean; suggestions?: string[] }
}

let app: FastifyInstance
let baseUrl: string
let agent: Client
let cookie: string
let strangerCookie: string
let vaultId: string
let strangerVaultId: string
let repoId: string
/** Node ids by path (notes) or `file:<path>` (repository files). */
const idOf: Record<string, string> = {}
const strangerIds: string[] = []

async function call(name: string, args: Args): Promise<{ isError: boolean; text: string }> {
  resetRateLimits()
  const result = await agent.callTool({ name, arguments: args })
  const content = result.content as Array<{ type: string; text?: string }>
  return { isError: result.isError === true, text: content.map((c) => c.text ?? '').join('') }
}

async function answer(name: string, args: Args): Promise<Record<string, unknown>> {
  const r = await call(name, args)
  expect(r.isError, `${name} ${JSON.stringify(args)}: ${r.text.slice(0, 300)}`).toBe(false)
  return JSON.parse(r.text) as Record<string, unknown>
}

async function refusal(name: string, args: Args): Promise<ErrorBody> {
  const r = await call(name, args)
  expect(r.isError, `${name} ${JSON.stringify(args)}: ${r.text.slice(0, 300)}`).toBe(true)
  return JSON.parse(r.text) as ErrorBody
}

/** Both the vault and the repository. */
const both = () => ({ vaultId, repositoryId: repoId })
const centerOf = async (neighborsOf: string, scope: Args = both()) =>
  (await answer('graph', { ...scope, neighborsOf, budget_tokens: 25_000 })).center as { id: string; path: string }
const candidatesOf = (json: Record<string, unknown>) => json.candidates as Candidate[]

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  const stranger = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  strangerCookie = await loginCookie(app, stranger.email)

  // Each account's vault is mergeable and in its own merged graph.
  const vaultFor = async (who: string, name: string) => {
    const id = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie: who }, body: { name } })).json<{ id: string }>().id
    await app.inject({ method: 'PATCH', url: `/api/vaults/${id}`, headers: { cookie: who }, body: { mergeable: true } })
    await app.inject({ method: 'PUT', url: `/api/vaults/${id}/graph-preference`, headers: { cookie: who }, body: { include: true } })
    return id
  }
  vaultId = await vaultFor(cookie, 'resolver vault')
  strangerVaultId = await vaultFor(strangerCookie, 'stranger vault')
  repoId = (await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name: 'resolver-repo', ingestionMethod: 'agent_push' } })).json<{
    id: string
  }>().id

  const notes: Array<{ path: string; body: string; frontmatter?: Record<string, unknown> }> = [
    { path: 'concepts/alpha', body: 'Links to [[concepts/beta]].' },
    { path: 'concepts/beta', body: 'Target note.' },
    { path: 'projects/store-plan', body: 'Plan.', frontmatter: { title: 'Storage Roadmap' } },
    { path: 'notes/readme', body: 'One readme.' },
    { path: 'docs/guides/readme', body: 'Another readme.' },
    // Twelve notes named `item`: more than the 10 candidates shown.
    ...Array.from({ length: 12 }, (_, i) => ({ path: `many/m${String(i).padStart(2, '0')}/item`, body: `Item ${i}.` })),
  ]
  for (const n of notes) idOf[n.path] = (await createNote(vaultId, n)).id
  const files = [
    { path: 'server/src/notes/store.ts', content: 'export const store = 1' },
    { path: 'client/src/store.tsx', content: 'export const view = 2' },
    { path: 'pkg/readme.md', content: '# readme' },
  ]
  await syncRepositoryFiles(repoId, files, files.map((f) => f.path))
  // The stranger's vault holds the same names, and a note only it has.
  for (const path of ['notes/readme', 'concepts/store', 'ledger/quarterly']) {
    strangerIds.push((await createNote(strangerVaultId, { path, body: 'Not yours.', frontmatter: { title: 'Storage Roadmap' } })).id)
  }
  await flushExtraction()
  await flushEmbeddings()
  const fileRows = await app.inject({ method: 'GET', url: `/api/repositories/${repoId}/files`, headers: { cookie } })
  for (const f of fileRows.json<Array<{ id: string; path: string }>>()) idOf[`file:${f.path}`] = f.id

  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: 'resolver-agent', scope: 'account' } })
  agent = new Client({ name: 'graph-resolve-node-test', version: '0.0.0' })
  await agent.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } },
    }),
  )
}, 120_000)

afterAll(async () => {
  await agent?.close().catch(() => {})
  await app.close()
})

describe('graph neighborsOf resolves a node reference (#447)', () => {
  it('still takes an exact id and an exact path', async () => {
    expect(await centerOf(idOf['concepts/alpha']!)).toEqual({ id: idOf['concepts/alpha'], path: 'concepts/alpha' })
    expect(await centerOf('concepts/alpha')).toEqual({ id: idOf['concepts/alpha'], path: 'concepts/alpha' })
    expect((await centerOf('server/src/notes/store.ts')).id).toBe(idOf['file:server/src/notes/store.ts'])
  })

  it('takes a path without its extension, in any case, and a note path with .md', async () => {
    expect((await centerOf('server/src/notes/store')).id).toBe(idOf['file:server/src/notes/store.ts'])
    expect((await centerOf('Concepts/Alpha')).id).toBe(idOf['concepts/alpha'])
    expect((await centerOf('concepts/alpha.md')).id).toBe(idOf['concepts/alpha'])
  })

  it('takes a unique path suffix on a segment boundary', async () => {
    expect((await centerOf('notes/store.ts')).id).toBe(idOf['file:server/src/notes/store.ts'])
    // `store.ts` is not `store.tsx`: the other file does not match.
    expect((await centerOf('store.ts')).id).toBe(idOf['file:server/src/notes/store.ts'])
    expect((await centerOf('src/store.tsx')).id).toBe(idOf['file:client/src/store.tsx'])
    // Not inside a segment: `tes/store.ts` is not a suffix of `notes/store.ts` on a boundary.
    expect((await refusal('graph', { ...both(), neighborsOf: 'tes/store.ts' })).error.code).toBe('NOT_FOUND')
  })

  it('takes a unique basename or note title', async () => {
    expect((await centerOf('beta')).id).toBe(idOf['concepts/beta'])
    expect((await centerOf('store-plan')).id).toBe(idOf['projects/store-plan'])
    expect((await centerOf('Storage Roadmap')).id).toBe(idOf['projects/store-plan'])
  })

  it('answers an ambiguous name with candidates, shorter path first, the same every time', async () => {
    const json = await answer('graph', { ...both(), neighborsOf: 'readme' })
    expect(candidatesOf(json)).toEqual([
      { path: 'notes/readme', kind: 'note', id: idOf['notes/readme'] },
      { path: 'pkg/readme.md', kind: 'code', id: idOf['file:pkg/readme.md'] },
      { path: 'docs/guides/readme', kind: 'note', id: idOf['docs/guides/readme'] },
    ])
    expect(json.truncated).toBe(false)
    expect(json).not.toHaveProperty('nodes')
    expect(await call('graph', { ...both(), neighborsOf: 'readme' })).toEqual(await call('graph', { ...both(), neighborsOf: 'readme' }))
    // `store`: the file server/src/notes/store.ts and client/src/store.tsx.
    expect(candidatesOf(await answer('graph', { ...both(), neighborsOf: 'store' })).map((c) => c.path)).toEqual(['client/src/store.tsx', 'server/src/notes/store.ts'])
  })

  it('shows at most 10 candidates and says how many there are', async () => {
    const json = await answer('graph', { vaultId, neighborsOf: 'item' })
    expect(candidatesOf(json).map((c) => c.path)).toEqual(Array.from({ length: 10 }, (_, i) => `many/m${String(i).padStart(2, '0')}/item`))
    expect(json.matches).toBe(12)
    expect(json.truncated).toMatchObject({ total: { candidates: '>10' } })
  })

  it('refuses a name that matches nothing with NOT_FOUND and nearby paths as suggestions', async () => {
    const { error } = await refusal('graph', { ...both(), neighborsOf: 'stroe.ts' })
    expect(error.code).toBe('NOT_FOUND')
    expect(error.message).toContain('stroe.ts')
    expect(error.suggestions).toContain('server/src/notes/store.ts')
    expect(error.suggestions!.length).toBeLessThanOrEqual(5)
    const readmes = (await refusal('graph', { ...both(), neighborsOf: 'guides/readmee' })).error
    expect(readmes.suggestions?.[0]).toBe('docs/guides/readme')
  })
})

describe('find_graph_path resolves both ends (#447)', () => {
  it('finds a path between a basename and a path with .md', async () => {
    const json = await answer('find_graph_path', { vaultId, source: 'alpha', target: 'concepts/beta.md' })
    expect(json.found).toBe(true)
    expect((json.nodes as Array<{ path: string }>).map((n) => n.path)).toEqual(['concepts/alpha', 'concepts/beta'])
  })

  it('answers an ambiguous end with its candidates and names the end', async () => {
    const source = await answer('find_graph_path', { ...both(), source: 'readme', target: 'concepts/beta' })
    expect(source.end).toBe('source')
    expect(candidatesOf(source).map((c) => c.path)).toEqual(['notes/readme', 'pkg/readme.md', 'docs/guides/readme'])
    const target = await answer('find_graph_path', { ...both(), source: 'concepts/beta', target: 'store' })
    expect(target.end).toBe('target')
    expect(candidatesOf(target).map((c) => c.path)).toEqual(['client/src/store.tsx', 'server/src/notes/store.ts'])
  })

  it('refuses an end that matches nothing, naming it, with suggestions', async () => {
    const { error } = await refusal('find_graph_path', { vaultId, source: 'concepts/alpha', target: 'concepts/betta' })
    expect(error.code).toBe('NOT_FOUND')
    expect(error.message).toMatch(/target/i)
    expect(error.suggestions).toContain('concepts/beta')
  })
})

describe('candidates and suggestions stay in the caller’s reach (#447)', () => {
  it('never lists another account’s nodes as candidates or suggestions', async () => {
    for (const scope of [both(), { vaultId }]) {
      const json = await answer('graph', { ...scope, neighborsOf: 'readme' })
      const mine = [idOf['notes/readme'], ...('repositoryId' in scope ? [idOf['file:pkg/readme.md']] : []), idOf['docs/guides/readme']]
      expect(candidatesOf(json).map((c) => c.id)).toEqual(mine)
      for (const id of strangerIds) expect(JSON.stringify(json)).not.toContain(id)
      // The stranger's note titled "Storage Roadmap" is not a second match.
      expect((await centerOf('Storage Roadmap', scope)).id).toBe(idOf['projects/store-plan'])
      // Only the stranger has ledger/quarterly: the refusal is a plain not-found, without suggestions.
      const { error } = await refusal('graph', { ...scope, neighborsOf: 'quarterly' })
      expect(error.code).toBe('NOT_FOUND')
      expect(error).not.toHaveProperty('suggestions')
      expect((await refusal('find_graph_path', { ...scope, source: 'quarterly', target: 'readme' })).error).not.toHaveProperty('suggestions')
      const near = await refusal('graph', { ...scope, neighborsOf: 'concepts/stor' })
      expect(near.error.suggestions ?? []).not.toContain('concepts/store')
    }
    // Another account's node id answers as an id that does not exist.
    const missing = await call('graph', { ...both(), neighborsOf: '00000000-0000-4000-8000-000000000000' })
    const theirs = await call('graph', { ...both(), neighborsOf: strangerIds[0]! })
    expect(theirs.text.replace(strangerIds[0]!, '00000000-0000-4000-8000-000000000000')).toBe(missing.text)
    expect(JSON.parse(theirs.text)).not.toHaveProperty('error.suggestions')
    // The stranger's vault itself is the plain not-found of a missing id, byte for byte.
    const NOT_FOUND = '{"error":{"code":"NOT_FOUND","message":"not found","retryable":false}}'
    expect(await call('graph', { vaultId: strangerVaultId, neighborsOf: 'quarterly' })).toEqual({ isError: true, text: NOT_FOUND })
    expect(await call('find_graph_path', { vaultId: strangerVaultId, source: 'quarterly', target: 'readme' })).toEqual({ isError: true, text: NOT_FOUND })
  })
})

describe('the REST path routes resolve ends the same way (#447)', () => {
  const get = (url: string, who = cookie) => app.inject({ method: 'GET', url, headers: { cookie: who } })
  const q = (source: string, target: string) => new URLSearchParams({ source, target }).toString()

  it('finds a path between a basename and a path with .md', async () => {
    const res = await get(`/api/vaults/${vaultId}/graph/path?${q('alpha', 'concepts/beta.md')}`)
    expect(res.statusCode).toBe(200)
    expect(res.json<{ found: boolean; nodes: Array<{ path: string }> }>().nodes.map((n) => n.path)).toEqual(['concepts/alpha', 'concepts/beta'])
  })

  it('answers an ambiguous end with candidates, and a missing one 404 with suggestions', async () => {
    const res = await get(`/api/vaults/${vaultId}/graph/path?${q('readme', 'concepts/beta')}`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      end: 'source',
      candidates: [
        { path: 'notes/readme', kind: 'note', id: idOf['notes/readme'] },
        { path: 'docs/guides/readme', kind: 'note', id: idOf['docs/guides/readme'] },
      ],
      truncated: false,
    })
    const many = await get(`/api/vaults/${vaultId}/graph/path?${q('concepts/beta', 'item')}`)
    expect(many.json<{ end: string; candidates: Candidate[]; truncated: number }>()).toMatchObject({ end: 'target', truncated: 2 })
    const missing = await get(`/api/vaults/${vaultId}/graph/path?${q('concepts/alpha', 'concepts/betta')}`)
    expect(missing.statusCode).toBe(404)
    expect(missing.json<{ error: string; suggestions: string[] }>().suggestions).toContain('concepts/beta')
  })

  it('keeps the merged graph to the caller’s vaults', async () => {
    const res = await get(`/api/graph/merged/path?${q('readme', 'concepts/beta')}`)
    expect(res.statusCode).toBe(200)
    expect(res.json<{ candidates: Candidate[] }>().candidates.map((c) => c.id)).toEqual([idOf['notes/readme'], idOf['docs/guides/readme']])
    const quarterly = await get(`/api/graph/merged/path?${q('quarterly', 'concepts/beta')}`)
    expect(quarterly.statusCode).toBe(404)
    expect(quarterly.json()).not.toHaveProperty('suggestions')
    // The stranger resolves its own note by the same name.
    const own = await get(`/api/graph/merged/path?${q('quarterly', 'quarterly')}`, strangerCookie)
    expect(own.statusCode).toBe(200)
    expect(own.json<{ found: boolean }>().found).toBe(true)
  })
})
