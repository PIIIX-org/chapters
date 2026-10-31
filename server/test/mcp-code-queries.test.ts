// #470: `find_symbols` with `refs` answers the code questions over the code edges (#469): the symbol at
// `path:line` (`at`), the `references` and `callers` of a symbol, its `impact` grouped by depth and the
// `tests` that use it. Each row is `path:line`, the enclosing symbol, one line of context, the kind of
// edge and the confidence. An ambiguous name answers its candidates; another account's repository is
// not reachable, and says what a missing one says. The store's own cases: code-queries-store.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { createActiveUser, loginCookie } from './helpers.js'
import { FIXTURE } from './code-queries-fixture.js'

let app: FastifyInstance
let baseUrl: string
let repoId: string
let otherRepoId: string
let agent: Client
let stranger: Client
const clients: Client[] = []

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

async function connect(cookie: string, name: string): Promise<Client> {
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name, scope: 'account' } })
  const client = new Client({ name, version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } } }),
  )
  clients.push(client)
  return client
}

async function ask(who: Client, args: Record<string, unknown>) {
  resetRateLimits()
  const result = await who.callTool({ name: 'find_symbols', arguments: args })
  const text = (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('')
  return { isError: result.isError === true, text, json: JSON.parse(text) as Json, structured: result.structuredContent }
}
const q = (query: string, refs: string, more: Record<string, unknown> = {}) => ask(agent, { repositoryId: repoId, query, refs, ...more })
const rows = (r: Json[]) => r.map((x) => `${x.at} ${x.in ?? '-'} ${x.kind} ${x.confidence}`)

async function repository(cookie: string, name: string): Promise<string> {
  return (await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name, ingestionMethod: 'agent_push' } })).json<{ id: string }>().id
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  const cookie = await loginCookie(app, owner.email)
  repoId = await repository(cookie, 'code-queries')
  agent = await connect(cookie, 'code-queries-agent')
  const other = await createActiveUser()
  const otherCookie = await loginCookie(app, other.email)
  otherRepoId = await repository(otherCookie, 'code-queries-other')
  stranger = await connect(otherCookie, 'code-queries-stranger')
  const files = Object.entries(FIXTURE).map(([path, content]) => ({ path, content }))
  await syncRepositoryFiles(repoId, files, Object.keys(FIXTURE))
  // The stranger's repository holds a `normalize` and a caller of it of its own.
  await syncRepositoryFiles(
    otherRepoId,
    [{ path: 'secret/normalize.ts', content: 'export function normalize(s: string) {\n  return s\n}\n\nexport function leak() {\n  return normalize("x")\n}\n' }],
    ['secret/normalize.ts'],
  )
  await flushExtraction()
}, 120_000)

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => {})
  await app.close()
})

describe('find_symbols refs: callers, references, tests (#470)', () => {
  it('callers: path:line, enclosing symbol, context, kind and confidence; resolved rows first', async () => {
    const r = await q('normalize', 'callers')
    expect(r.isError, r.text).toBe(false)
    expect(rows(r.json.results)).toEqual(['src/handler.ts:6 handle call resolved', 'src/store.test.ts:4 - call resolved', 'src/store.ts:3 Store.save call resolved'])
    expect(r.json.results[0]).toEqual({ at: 'src/handler.ts:6', in: 'handle', kind: 'call', confidence: 'resolved', context: 'return normalize(x)' })
    expect(r.json.symbol).toMatchObject({ path: 'src/store.ts', name: 'normalize', kind: 'function', line: 10 })
    expect(r.json.truncated).toBe(false)
    // The same object as `structuredContent` (#433), and the one indexed version of the repository.
    expect(r.structured).toEqual(r.json)
  })

  it('references add the imports; tests are the test edges alone', async () => {
    expect(rows((await q('normalize', 'references')).json.results)).toEqual([
      'src/handler.ts:1 - import resolved',
      'src/handler.ts:6 handle call resolved',
      'src/store.test.ts:1 - import resolved',
      'src/store.test.ts:4 - call resolved',
      'src/store.ts:3 Store.save call resolved',
    ])
    expect(rows((await q('normalize', 'tests')).json.results)).toEqual(['src/store.test.ts:4 - test resolved'])
    expect(rows((await q('helper', 'tests')).json.results)).toEqual(['tests/test_util.py:5 test_helper test textual'])
  })

  it('Python: cross-file calls are textual, and a method is found by Class.method or its bare name', async () => {
    expect(rows((await q('helper', 'callers')).json.results)).toEqual(['lib/util.py:6 run call resolved', 'lib/main.py:5 main call textual', 'tests/test_util.py:5 test_helper call textual'])
    for (const name of ['Store.save', 'save']) expect(rows((await q(name, 'callers')).json.results), name).toEqual(['src/store.ts:6 Store.load call resolved', 'src/handler.ts:5 handle call textual'])
  })

  it('pages with the cursor: the pages are the whole answer', async () => {
    const whole = (await q('normalize', 'references')).json.results
    const seen: Json[] = []
    let cursor: string | undefined
    for (let page = 0; page < 10; page++) {
      const r = await q('normalize', 'references', { limit: 2, ...(cursor ? { cursor } : {}) })
      expect(r.isError, r.text).toBe(false)
      seen.push(...r.json.results)
      cursor = r.json.truncated === false ? undefined : (r.json.truncated.cursor ?? undefined)
      if (!cursor) break
    }
    expect(seen).toEqual(whole)
  })
})

describe('find_symbols refs: at (#470)', () => {
  it('names the symbol around a line and what the line refers to', async () => {
    const r = await q('src/store.ts:3', 'at')
    expect(r.isError, r.text).toBe(false)
    expect(r.json.at).toBe('src/store.ts:3')
    expect(r.json.symbol).toMatchObject({ path: 'src/store.ts', name: 'save', parent: 'Store', kind: 'method', line: 2 })
    expect(r.json.results).toEqual([{ kind: 'call', name: 'normalize', confidence: 'resolved', to: 'src/store.ts#normalize' }])
  })

  it('a line between symbols has none; a missing file or a malformed query is refused', async () => {
    expect((await q('src/store.ts:9', 'at')).json.symbol).toBeNull()
    const missing = await q('src/nothing.ts:1', 'at')
    expect([missing.isError, missing.json.error.code]).toEqual([true, 'NOT_FOUND'])
    const malformed = await q('src/store.ts', 'at')
    expect([malformed.isError, malformed.json.error.code]).toEqual([true, 'INVALID_ARGUMENT'])
  })
})

describe('find_symbols refs: impact (#470)', () => {
  it('groups by depth with the total of each level', async () => {
    const r = await q('normalize', 'impact', { depth: 3 })
    expect(r.isError, r.text).toBe(false)
    expect(rows(r.json.depth1)).toEqual(['src/handler.ts:6 handle call resolved', 'src/store.test.ts:4 - call resolved', 'src/store.ts:3 Store.save call resolved'])
    expect(rows(r.json.depth2)).toEqual(['src/handler.ts:10 route call resolved', 'src/store.ts:6 Store.load call resolved'])
    expect(rows(r.json.depth3)).toEqual(['src/handler.ts:14 top call resolved'])
    expect(r.json.depth2.map((x: Json) => x.to)).toEqual(['src/handler.ts#handle', 'src/store.ts#Store.save'])
    expect(r.json.total).toEqual({ 1: 3, 2: 2, 3: 1 })
  })

  it('the default depth is 2; a limit cuts each level and the totals say how many there are', async () => {
    expect((await q('normalize', 'impact')).json).not.toHaveProperty('depth3')
    const r = await q('normalize', 'impact', { depth: 2, limit: 1 })
    expect([r.json.depth1.length, r.json.depth2.length]).toEqual([1, 1])
    expect(r.json.total).toEqual({ 1: 3, 2: 2 })
    expect(r.json.truncated).toMatchObject({ shown: { depth1: 1, depth2: 1 } })
  })

  it('a depth over 3 is refused', async () => {
    const r = await q('normalize', 'impact', { depth: 4 })
    expect(r.isError).toBe(true)
  })
})

describe('find_symbols refs: ambiguity (#470)', () => {
  it('a name with several definitions answers the candidates, never a guess', async () => {
    const r = await q('parse', 'callers')
    expect(r.isError, r.text).toBe(false)
    expect(r.json).not.toHaveProperty('results')
    expect(r.json.candidates.map((c: Json) => [c.path, c.kind, c.name, c.line])).toEqual([
      ['src/other.ts', 'function', 'parse', 1],
      ['src/store.ts', 'function', 'parse', 14],
    ])
    expect(r.json.candidates[0].id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('a path or a symbol id picks one; the package’s own `parse` is not a caller of either', async () => {
    expect(rows((await q('parse', 'callers', { path: 'src/other.ts' })).json.results)).toEqual(['src/reader.ts:4 read call resolved'])
    expect((await q('parse', 'callers', { path: 'src/store.ts' })).json.results).toEqual([])
    const { candidates } = (await q('parse', 'tests')).json
    const byId = await q(candidates[0].id, 'callers')
    expect(rows(byId.json.results)).toEqual(['src/reader.ts:4 read call resolved'])
    expect(byId.json.symbol.path).toBe('src/other.ts')
  })

  it('a name nothing defines and nothing names is not found; one only named answers its textual sites', async () => {
    const r = await q('doesNotExist', 'callers')
    expect([r.isError, r.json.error.code]).toEqual([true, 'NOT_FOUND'])
    expect((await q('normalize', 'callers', { path: 'src/other.ts' })).json.error.code).toBe('NOT_FOUND')
    const named = await q('legacyHelper', 'callers')
    expect(named.isError, named.text).toBe(false)
    expect(rows(named.json.results)).toEqual(['src/path-user.ts:8 legacy call textual'])
    expect(named.json.symbol).toEqual({ name: 'legacyHelper' })
  })
})

describe('find_symbols refs: arguments (#470)', () => {
  it('refs needs one repository; path and depth go with refs', async () => {
    const account = await ask(agent, { query: 'normalize', refs: 'callers' })
    expect([account.isError, account.json.error.code]).toEqual([true, 'INVALID_ARGUMENT'])
    const everywhere = await ask(agent, { query: 'normalize', refs: 'callers', everywhere: true })
    expect([everywhere.isError, everywhere.json.error.code]).toEqual([true, 'INVALID_ARGUMENT'])
    for (const extra of [{ path: 'src/store.ts' }, { depth: 2 }]) {
      const r = await ask(agent, { repositoryId: repoId, query: 'normalize', ...extra })
      expect([r.isError, r.json.error.code], JSON.stringify(extra)).toEqual([true, 'INVALID_ARGUMENT'])
    }
    const callersDepth = await q('normalize', 'callers', { depth: 2 })
    expect([callersDepth.isError, callersDepth.json.error.code]).toEqual([true, 'INVALID_ARGUMENT'])
  })

  it('without refs, find_symbols searches as before', async () => {
    const r = await ask(agent, { repositoryId: repoId, query: 'normalize' })
    expect(r.isError, r.text).toBe(false)
    expect(r.json.results[0]).toMatchObject({ name: 'normalize', kind: 'function', path: 'src/store.ts' })
  })
})

describe('find_symbols refs: another account (#470)', () => {
  it('names nothing of another account’s repository, and says what a missing one says', async () => {
    const missing = await ask(agent, { repositoryId: '00000000-0000-4000-8000-000000000000', query: 'normalize', refs: 'callers' })
    const foreign = await ask(agent, { repositoryId: otherRepoId, query: 'normalize', refs: 'callers' })
    expect(foreign.isError).toBe(true)
    expect(foreign.text).toBe(missing.text)
    expect(foreign.text).not.toContain('leak')
  })

  it('answers from the repository asked about only: its own `normalize` has no `leak` caller, the stranger’s has no `handle`', async () => {
    expect(JSON.stringify((await q('normalize', 'impact', { depth: 3 })).json)).not.toContain('leak')
    const theirs = await ask(stranger, { repositoryId: otherRepoId, query: 'normalize', refs: 'callers' })
    expect(rows(theirs.json.results)).toEqual(['secret/normalize.ts:6 leak call resolved'])
    expect(theirs.text).not.toContain('handle')
  })
})
