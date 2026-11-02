import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { createActiveUser, loginCookie } from './helpers.js'

// #534: `orient` answers a repository's ranked map (definitions by the resolved uses other files make of them, tests
// left out, biased to `query` and `focus`, at most 10 entries, signatures with `path:line`) and a vault's outline, one
// level at a time, inside the budget.

let app: FastifyInstance
let owner: Client
let stranger: Client
let repoId: string
let vaultId: string

type Symbols = Array<{ at: string; kind: string; symbol: string; sig: string; refs: number }>
type Answer = {
  commit?: string
  tree?: string
  symbols?: Symbols
  folders?: Array<{ path: string; files: number; refs: number }>
  outline?: Array<{ path: string; notes?: number; type?: string; links: number }>
  truncated: false | { level: string; total: Record<string, number | string>; shown: Record<string, number> }
}

async function connect(email: string, name: string, port: number): Promise<Client> {
  const cookie = await loginCookie(app, email)
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name, scope: 'account' } })
  const client = new Client({ name, version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } },
    }),
  )
  return client
}

async function ask(client: Client, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  resetRateLimits()
  const result = await client.callTool({ name: 'orient', arguments: args })
  const content = result.content as Array<{ text?: string }>
  return { isError: result.isError === true, text: content.map((c) => c.text ?? '').join('') }
}

async function orient(args: Record<string, unknown>): Promise<Answer> {
  const r = await ask(owner, args)
  expect(r.isError, r.text.slice(0, 300)).toBe(false)
  const budget = typeof args.budget_tokens === 'number' ? args.budget_tokens : 2_000
  expect(Math.ceil(r.text.length / 4), 'answer within its budget').toBeLessThanOrEqual(budget)
  return JSON.parse(r.text) as Answer
}

const FILES: Record<string, string> = {
  'src/core.ts': `export function core(): number {\n  return 1\n}\n\nexport function lonely(): number {\n  return 2\n}\n`,
  'src/lib/a.ts': `import { core } from '../core'\n\nexport function a(): number {\n  return core()\n}\n`,
  'src/lib/b.ts': `import { core } from '../core'\n\nexport function b(): number {\n  return core()\n}\n`,
  'src/lib/c.ts': `import { core } from '../core'\n\nexport function c(): number {\n  return core()\n}\n`,
  'src/app.ts': `import { a } from './lib/a'\n\nexport function main(): number {\n  return a()\n}\n`,
  // Five uses of `lonely` and `rare` from a test file: tests do not rank a definition.
  'src/core.test.ts': `import { lonely } from './core'\n\ntest('x', () => {\n  lonely()\n  lonely()\n  lonely()\n  lonely()\n  lonely()\n})\n`,
}
const MANY = Array.from({ length: 12 }, (_, i) => `src/many/m${String(i).padStart(2, '0')}.ts`)
for (const path of MANY) FILES[path] = `export function ${path.slice(-6, -3)}(): number {\n  return 0\n}\n`

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const user = await createActiveUser()
  const cookie = await loginCookie(app, user.email)
  owner = await connect(user.email, 'orient-owner', port)
  stranger = await connect((await createActiveUser()).email, 'orient-stranger', port)
  repoId = (await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name: 'orient-repo', ingestionMethod: 'agent_push' } })).json<{ id: string }>().id
  await syncRepositoryFiles(repoId, Object.entries(FILES).map(([path, content]) => ({ path, content })), Object.keys(FILES), { commit: 'a'.repeat(40) })
  await flushExtraction()
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'orient-vault' } })).json<{ id: string }>().id
  const note = (type: string, name: string, body: string) =>
    app.inject({ method: 'POST', url: `/api/vaults/${vaultId}/notes`, headers: { cookie }, body: { type, name, body } })
  await note('concepts', 'alpha', 'The alpha concept.')
  await note('concepts', 'beta', 'The beta concept.')
  await note('guides', 'one', 'See [[concepts/alpha]] and [[concepts/beta]].')
  await note('guides', 'two', 'See [[concepts/alpha]].')
}, 120_000)

afterAll(async () => {
  await owner?.close().catch(() => {})
  await stranger?.close().catch(() => {})
  await app?.close()
})

describe('orient: repository map', () => {
  it('ranks definitions by the resolved uses other files make of them, with signatures and path:line, and names the indexed commit', async () => {
    const json = await orient({ repositoryId: repoId })
    expect(json.commit).toBe('a'.repeat(40))
    // core: an import row and a call row from each of a, b and c. a: the same from app. Then no uses, by path and line.
    expect(json.symbols!.slice(0, 2)).toEqual([
      { at: 'src/core.ts:1', kind: 'function', symbol: 'core', sig: 'export function core(): number {', refs: 6 },
      { at: 'src/lib/a.ts:3', kind: 'function', symbol: 'a', sig: 'export function a(): number {', refs: 2 },
    ])
    expect(json.symbols!.slice(2).every((s) => s.refs === 0)).toBe(true)
    expect(json.symbols!.map((s) => s.at).slice(2)).toEqual([...json.symbols!.map((s) => s.at).slice(2)].sort())
  })

  it('leaves tests out: a definition used only by a test file has no uses, and nothing is listed from a test file', async () => {
    const json = await orient({ repositoryId: repoId, path: 'src', budget_tokens: 25_000 })
    const all = [...json.symbols!]
    expect(all.find((s) => s.symbol === 'lonely')?.refs ?? 0).toBe(0)
    expect(all.some((s) => s.at.startsWith('src/core.test.ts'))).toBe(false)
  })

  it('a query favours the symbols and paths that contain its words', async () => {
    const json = await orient({ repositoryId: repoId, query: 'lonely' })
    expect(json.symbols![0]).toMatchObject({ symbol: 'lonely', refs: 0 })
    expect(json.symbols![1]).toMatchObject({ symbol: 'core' })
  })

  it('a focus favours its files and what they use', async () => {
    const first = await orient({ repositoryId: repoId, focus: ['src/lib/c.ts'] })
    // c itself (20), then core (its own 6 uses and 5 for each of c's two), then a (2).
    expect(first.symbols!.slice(0, 3).map((s) => s.symbol)).toEqual(['c', 'core', 'a'])
    const many = await orient({ repositoryId: repoId, focus: ['src/many'] })
    expect(many.symbols!.slice(0, 10).every((s) => s.at.startsWith('src/many/'))).toBe(true)
  })

  it('shows at most 10 entries a list and says there are more', async () => {
    const json = await orient({ repositoryId: repoId, budget_tokens: 25_000 })
    expect(json.symbols).toHaveLength(10)
    expect(json.truncated).not.toBe(false)
    expect((json.truncated as { total: Record<string, number | string> }).total.symbols).toBe('>10')
  })

  it('one level at a time: folders name the paths one level down, `path` shows that level', async () => {
    const root = await orient({ repositoryId: repoId })
    expect(root.folders!.map((f) => f.path)).toEqual(['src/'])
    const src = await orient({ repositoryId: repoId, path: 'src' })
    expect(src.folders!.map((f) => f.path)).toEqual(['src/core.ts', 'src/lib/', 'src/app.ts', 'src/many/'])
    expect(src.folders![1]).toEqual({ path: 'src/lib/', files: 3, refs: 2 })
    const lib = await orient({ repositoryId: repoId, path: 'src/lib/' })
    expect(lib.symbols!.map((s) => s.symbol)).toEqual(['a', 'b', 'c'])
    expect(lib.folders!.map((f) => f.path)).toEqual(['src/lib/a.ts', 'src/lib/b.ts', 'src/lib/c.ts'])
  })

  it('fits a small budget by stepping down the ladder, never over it', async () => {
    const json = await orient({ repositoryId: repoId, budget_tokens: 256 })
    expect(json.truncated).not.toBe(false)
  })

  it('answers the same bytes twice', async () => {
    const first = await ask(owner, { repositoryId: repoId, query: 'core', focus: ['src/lib'] })
    expect((await ask(owner, { repositoryId: repoId, query: 'core', focus: ['src/lib'] })).text).toBe(first.text)
  })
})

describe('orient: vault outline', () => {
  it('lists the folders and notes of a level by the links that name them', async () => {
    const root = await orient({ vaultId })
    expect(root.outline).toEqual([
      { path: 'concepts/', notes: 2, links: 3 },
      { path: 'guides/', notes: 2, links: 0 },
    ])
    const concepts = await orient({ vaultId, path: 'concepts' })
    expect(concepts.outline).toEqual([
      { path: 'concepts/alpha', type: 'concepts', links: 2 },
      { path: 'concepts/beta', type: 'concepts', links: 1 },
    ])
  })

  it('a repository and a vault together answer both', async () => {
    const json = await orient({ vaultId, repositoryId: repoId })
    expect(json.symbols).toBeDefined()
    expect(json.outline).toBeDefined()
  })
})

describe('orient: access', () => {
  it('an account that cannot read the repository or the vault is refused as for a missing one', async () => {
    const missing = await ask(stranger, { repositoryId: '00000000-0000-4000-8000-000000000000' })
    const repo = await ask(stranger, { repositoryId: repoId })
    expect(repo.isError).toBe(true)
    expect(repo.text).toBe(missing.text)
    const vault = await ask(stranger, { vaultId })
    expect(vault.isError).toBe(true)
    expect(vault.text).not.toContain('concepts')
  })
})
