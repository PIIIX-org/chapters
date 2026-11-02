import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { notes } from '../src/db/schema.js'
import { createActiveUser, loginCookie } from './helpers.js'

// #675: `find_symbols` with `refs: "explain"` answers where a symbol is, who calls it, which tests use it and which
// notes cite its file (and whether they are current) in one answer, packed into the budget by the response ladder.

const COMMIT = 'abcdef0123456789abcdef0123456789abcdef01'

let app: FastifyInstance
let port: number
let owner: Client
let stranger: Client
let pinned: Client
let repoId: string
let vaultId: string
let cookie: string

type Site = { at: string; in?: string; kind: string; confidence: string; context?: string }
type Answer = {
  refs: string
  commit?: string
  symbol?: { at: string; name: string; kind: string; sig?: string; id: string }
  callers?: Array<Site | string>
  tests?: Array<Site | string>
  cites?: Array<{ vault: string; at: string; fresh: string; context?: string | null } | string>
  candidates?: unknown[]
  truncated: false | { level: string; shown: Record<string, number>; total: Record<string, number | string> }
}

async function connect(email: string, name: string, body: Record<string, unknown> = {}): Promise<Client> {
  const login = await loginCookie(app, email)
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie: login }, body: { name, scope: 'account', ...body } })
  const client = new Client({ name, version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } } }))
  return client
}

async function ask(client: Client, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  resetRateLimits()
  const result = await client.callTool({ name: 'find_symbols', arguments: { refs: 'explain', repositoryId: repoId, ...args } })
  const content = result.content as Array<{ text?: string }>
  return { isError: result.isError === true, text: content.map((c) => c.text ?? '').join('') }
}

async function explain(args: Record<string, unknown>): Promise<Answer> {
  const r = await ask(owner, args)
  expect(r.isError, r.text.slice(0, 300)).toBe(false)
  const budget = typeof args.budget_tokens === 'number' ? args.budget_tokens : 2_000
  expect(Math.ceil(r.text.length / 4), 'within its budget').toBeLessThanOrEqual(budget)
  return JSON.parse(r.text) as Answer
}

const STORE = `export class Store {\n  save(id: string): string {\n    return id\n  }\n}\n\nexport function persist(id: string): string {\n  return id\n}\n`
const callerFile = (n: number) => `import { persist } from './store'\n\nexport function handler${n}(): string {\n  return persist('${n}')\n}\n`

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  port = typeof address === 'object' && address ? address.port : 0
  const user = await createActiveUser()
  cookie = await loginCookie(app, user.email)
  owner = await connect(user.email, 'explain-owner')
  stranger = await connect((await createActiveUser()).email, 'explain-stranger')
  repoId = (await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name: 'explain-repo', ingestionMethod: 'agent_push' } })).json<{ id: string }>().id
  pinned = await connect(user.email, 'explain-pinned', { scope: 'repository', repositoryId: repoId })
  const files: Record<string, string> = {
    'src/store.ts': STORE,
    'src/store.test.ts': `import { persist } from './store'\n\ntest('persist', () => {\n  persist('a')\n})\n`,
    'src/dup1.ts': 'export function twice(): number {\n  return 1\n}\n',
    'src/dup2.ts': 'export function twice(): number {\n  return 2\n}\n',
  }
  for (let i = 1; i <= 7; i += 1) files[`src/handler${i}.ts`] = callerFile(i)
  await syncRepositoryFiles(repoId, Object.entries(files).map(([path, content]) => ({ path, content })), Object.keys(files), { commit: COMMIT })
  await flushExtraction()
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'explain-vault' } })).json<{ id: string }>().id
  const note = (type: string, name: string, body: string) => app.inject({ method: 'POST', url: `/api/vaults/${vaultId}/notes`, headers: { cookie }, body: { type, name, body } })
  await note('decisions', 'why-persist', 'Why persist exists.\n\nDecision: see [[repo:explain-repo/src/store.ts]] for the write path.\n')
  await note('docs', 'other', 'Unrelated, see [[repo:explain-repo/src/dup1.ts]].\n')
}, 120_000)

afterAll(async () => {
  for (const c of [owner, stranger, pinned]) await c?.close().catch(() => {})
  await app?.close()
})

describe('find_symbols refs: explain', () => {
  it('locates the definition at the commit, lists callers in a total order, tests, and the notes that cite its file', async () => {
    const json = await explain({ query: 'persist' })
    expect(json.refs).toBe('explain')
    expect(json.commit).toBe(COMMIT)
    expect(json.symbol).toMatchObject({ at: 'src/store.ts#L7-L9', name: 'persist', kind: 'function', sig: 'export function persist(id: string): string {' })
    // Seven callers, five shown: path order (resolved before textual).
    expect((json.callers as Site[]).map((s) => s.at)).toEqual(['src/handler1.ts:4', 'src/handler2.ts:4', 'src/handler3.ts:4', 'src/handler4.ts:4', 'src/handler5.ts:4'])
    expect((json.callers as Site[])[0]).toMatchObject({ in: 'handler1', kind: 'call', confidence: 'resolved' })
    expect((json.tests as Site[]).map((s) => s.at)).toEqual(['src/store.test.ts:4'])
    expect(json.cites).toHaveLength(1)
    expect((json.cites as Array<{ at: string; fresh: string; context: string }>)[0]).toMatchObject({ vault: vaultId, fresh: 'current' })
    expect((json.cites as Array<{ at: string }>)[0]!.at).toMatch(/^decisions\/why-persist#L\d+/)
    expect((json.cites as Array<{ context: string }>)[0]!.context).toContain('Decision: see')
    expect(json.truncated).not.toBe(false)
  })

  it('`path:line` explains the symbol around the line', async () => {
    const json = await explain({ query: 'src/store.ts:3' })
    expect(json.symbol).toMatchObject({ at: 'src/store.ts#L2-L4', name: 'save', kind: 'method' })
    expect((await explain({ query: 'src/dup1.ts:99' })).symbol).toEqual({ at: 'src/dup1.ts' })
  })

  it('a note written before the file changed is stale', async () => {
    // The note's last write, a day before the file changes (its row is touched by background indexing).
    await db.update(notes).set({ updatedAt: new Date(Date.now() - 24 * 3600 * 1000) }).where(eq(notes.vaultId, vaultId))
    await syncRepositoryFiles(repoId, [{ path: 'src/dup1.ts', content: 'export function twice(): number {\n  return 3\n}\n' }], ['src/store.ts', 'src/store.test.ts', 'src/dup1.ts', 'src/dup2.ts', ...Array.from({ length: 7 }, (_, i) => `src/handler${i + 1}.ts`)], { commit: COMMIT })
    const json = await explain({ query: 'src/dup1.ts:1' })
    expect((json.cites as Array<{ fresh: string }>)[0]!.fresh).toBe('stale')
    await db.update(notes).set({ updatedAt: new Date(Date.now() + 3600 * 1000) }).where(eq(notes.vaultId, vaultId))
    expect(((await explain({ query: 'src/dup1.ts:1' })).cites as Array<{ fresh: string }>)[0]!.fresh).toBe('current')
  })

  it('a name with several definitions answers its candidates and nothing else', async () => {
    const json = await explain({ query: 'twice' })
    expect(json.candidates).toHaveLength(2)
    expect(json.callers).toBeUndefined()
    expect((await explain({ query: 'twice', path: 'src/dup2.ts' })).symbol).toMatchObject({ at: 'src/dup2.ts#L1-L3' })
  })

  it('steps down the ladder under a small budget and says what it left out', async () => {
    const small = await explain({ query: 'persist', budget_tokens: 256 })
    expect(small.truncated).not.toBe(false)
    const full = await ask(owner, { query: 'persist', budget_tokens: 25_000 })
    expect(JSON.parse(full.text).symbol.at).toBe('src/store.ts#L7-L9')
  })

  it('refuses what it cannot answer: an unknown symbol, depth, no repository', async () => {
    expect((await ask(owner, { query: 'nothingHere' })).text).toMatch(/NOT_FOUND/)
    expect((await ask(owner, { query: 'persist', depth: 2 })).text).toMatch(/INVALID_ARGUMENT/)
    resetRateLimits()
    const none = await owner.callTool({ name: 'find_symbols', arguments: { query: 'persist', refs: 'explain' } })
    expect(none.isError).toBe(true)
  })

  it('is one call where the multi-call path takes five, in fewer tokens (#675 measure)', async () => {
    const call = async (name: string, args: Record<string, unknown>) => {
      resetRateLimits()
      const r = await owner.callTool({ name, arguments: args })
      return (r.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('')
    }
    const chain = [
      await call('find_symbols', { repositoryId: repoId, query: 'persist' }),
      await call('find_symbols', { repositoryId: repoId, query: 'persist', refs: 'callers' }),
      await call('find_symbols', { repositoryId: repoId, query: 'persist', refs: 'tests' }),
      await call('graph', { repositoryId: repoId, vaultId, neighborsOf: 'src/store.ts', aggregate: 'none' }),
      await call('read_note', { vaultId, path: 'decisions/why-persist' }),
    ]
    const one = (await ask(owner, { query: 'persist' })).text
    const tokens = (t: string) => Math.ceil(t.length / 4)
    const chained = chain.reduce((n, t) => n + tokens(t), 0)
    console.log(`explain: 1 call, ${tokens(one)} tokens; multi-call path: ${chain.length} calls, ${chained} tokens`)
    expect(tokens(one)).toBeLessThan(chained)
  })

  it('answers the same bytes twice', async () => {
    expect((await ask(owner, { query: 'persist' })).text).toBe((await ask(owner, { query: 'persist' })).text)
  })

  it('an account that cannot read the repository is refused as for a missing one; a repository-pinned token sees no notes', async () => {
    const missing = await ask(stranger, { query: 'persist', repositoryId: '00000000-0000-4000-8000-000000000000' })
    const repo = await ask(stranger, { query: 'persist' })
    expect(repo.isError).toBe(true)
    expect(repo.text).toBe(missing.text)
    const pin = await ask(pinned, { query: 'persist' })
    expect(pin.isError, pin.text.slice(0, 200)).toBe(false)
    expect(JSON.parse(pin.text).symbol.name).toBe('persist')
    expect(pin.text).not.toContain('why-persist')
  })
})
