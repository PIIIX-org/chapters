// #425: `browse_vault` lists one level by default, at the root as in a
// folder (notes directly in it, subfolders with their note counts);
// `recursive: true` lists the subtree under `path` (the whole vault without
// it), never the whole vault for a `path`. Items are `{path, title}` unless
// `fields` picks others from an allowlist. Pages come from the database in
// code-unit path order with a keyset, and the cursor is bound to `path`,
// `recursive` and `fields`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { createNote } from '../src/notes/store.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Args = Record<string, unknown>
type Truncated = false | { shown: Record<string, number>; total: Record<string, number | string>; dropped: Record<string, number>; level: string; cursor: string | null }
type Answer = {
  directory?: string
  subdirectories?: Array<{ name: string; count: number }>
  notes: Array<Record<string, unknown>>
  indexContent?: string
  truncated: Truncated
}

let app: FastifyInstance
let agent: Client
let vaultId: string

const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Root notes, a folder with notes and a nested folder, and neighbours a string prefix of `docs/` would match. */
const NOTES = [
  'readme',
  'zeta',
  'docs/intro',
  'docs/setup',
  'docs/api/auth',
  'docs/api/search',
  'docs/api/v2/paging',
  'docs-old/legacy',
  'docsx',
  ...Array.from({ length: 30 }, (_, i) => `log/entry-${String(i).padStart(2, '0')}`),
]

async function call(args: Args): Promise<{ isError: boolean; text: string }> {
  resetRateLimits()
  const result = await agent.callTool({ name: 'browse_vault', arguments: { vaultId, ...args } })
  const content = result.content as Array<{ type: string; text?: string }>
  return { isError: result.isError === true, text: content.map((c) => c.text ?? '').join('') }
}

async function page(args: Args): Promise<Answer> {
  const r = await call(args)
  expect(r.isError, r.text.slice(0, 300)).toBe(false)
  const budget = typeof args.budget_tokens === 'number' ? args.budget_tokens : 2_000
  expect(Math.ceil(r.text.length / 4)).toBeLessThanOrEqual(budget)
  const json = JSON.parse(r.text) as Answer
  expect(Object.keys(json).at(-1)).toBe('truncated')
  return json
}

async function walk(args: Args): Promise<Answer[]> {
  const pages: Answer[] = []
  let cursor: string | null = null
  for (;;) {
    const json = await page({ ...args, ...(cursor ? { cursor } : {}) })
    pages.push(json)
    cursor = json.truncated === false ? null : json.truncated.cursor
    if (cursor === null) return pages
    if (pages.length > 100) throw new Error('never reached the last page')
  }
}

const pathsOf = (pages: Answer[]) => pages.flatMap((p) => p.notes.map((n) => n.path as string))

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  const cookie = await loginCookie(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'browse vault' } })).json<{ id: string }>().id
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: 'browse-vault-agent', scope: 'account' } })
  agent = new Client({ name: 'browse-vault-test', version: '0.0.0' })
  await agent.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } },
    }),
  )
  for (const path of NOTES) {
    const frontmatter = path === 'docs/intro' ? { title: 'Introduction', tags: ['guide', 'start'], owner: 'x'.repeat(200) } : {}
    await createNote(vaultId, { path, frontmatter, body: `Body of ${path}.` })
  }
}, 120_000)

afterAll(async () => {
  await agent?.close().catch(() => {})
  await app?.close()
})

describe('browse_vault one level', () => {
  it('the root with `recursive: false` lists only its own notes and its folders with their counts', async () => {
    const json = await page({ recursive: false, budget_tokens: 25_000 })
    expect(json.truncated).toBe(false)
    expect(json.notes.map((n) => n.path)).toEqual(['docsx', 'readme', 'zeta'])
    expect(json.subdirectories).toEqual([
      { name: 'docs', count: 5 },
      { name: 'docs-old', count: 1 },
      { name: 'log', count: 30 },
    ])
  })

  it('without `recursive` the root is one level too', async () => {
    const json = await page({ budget_tokens: 25_000 })
    expect(json.notes.map((n) => n.path)).toEqual(['docsx', 'readme', 'zeta'])
    expect(json.subdirectories?.map((d) => d.name)).toEqual(['docs', 'docs-old', 'log'])
  })

  it('a folder lists its own notes and subfolders, not its neighbours', async () => {
    const json = await page({ path: 'docs', budget_tokens: 25_000 })
    expect(json.directory).toBe('docs')
    expect(json.notes.map((n) => n.path)).toEqual(['docs/intro', 'docs/setup'])
    expect(json.subdirectories).toEqual([{ name: 'api', count: 3 }])
    const nested = await page({ path: 'docs/api', recursive: false, budget_tokens: 25_000 })
    expect(nested.notes.map((n) => n.path)).toEqual(['docs/api/auth', 'docs/api/search'])
    expect(nested.subdirectories).toEqual([{ name: 'v2', count: 1 }])
  })
})

describe('browse_vault recursive', () => {
  it('`recursive: true` with `path` lists that subtree only', async () => {
    const json = await page({ path: 'docs', recursive: true, budget_tokens: 25_000 })
    expect(json.truncated).toBe(false)
    expect(json.notes.map((n) => n.path)).toEqual(['docs/api/auth', 'docs/api/search', 'docs/api/v2/paging', 'docs/intro', 'docs/setup'])
    expect(json.subdirectories).toBeUndefined()
  })

  it('`recursive: true` without `path` lists every note of the vault by path', async () => {
    const json = await page({ recursive: true, budget_tokens: 25_000 })
    expect(json.notes.map((n) => n.path)).toEqual([...NOTES].sort(byCodeUnits))
  })
})

describe('browse_vault fields', () => {
  it('items are `{path, title}` by default; the title is `frontmatter.title`, else the name', async () => {
    const json = await page({ path: 'docs', budget_tokens: 25_000 })
    expect(json.notes).toEqual([
      { path: 'docs/intro', title: 'Introduction' },
      { path: 'docs/setup', title: 'setup' },
    ])
  })

  it('`fields` picks from the allowlist, in the allowlist order; `path` is always shown', async () => {
    const json = await page({ path: 'docs', fields: ['tags', 'id', 'path', 'updatedAt'], budget_tokens: 25_000 })
    expect(json.notes[0]).toEqual({ id: expect.any(String), path: 'docs/intro', tags: ['guide', 'start'], updatedAt: expect.any(String) })
    expect(Object.keys(json.notes[0]!)).toEqual(['id', 'path', 'tags', 'updatedAt'])
    const typed = await page({ path: 'docs', fields: ['type', 'name'], budget_tokens: 25_000 })
    expect(typed.notes[1]).toEqual({ path: 'docs/setup', type: 'docs', name: 'setup' })
  })

  it('fields outside the allowlist (frontmatter, body, embedding) are refused', async () => {
    for (const field of ['frontmatter', 'body', 'embedding']) {
      const r = await call({ fields: ['path', field] })
      expect(r.isError, field).toBe(true)
    }
  })
})

describe('browse_vault paging', () => {
  it('small pages list every path exactly once, in code-unit order, one level and recursive', async () => {
    const level = await walk({ path: 'log', budget_tokens: 256 })
    expect(level.length).toBeGreaterThan(1)
    expect(pathsOf(level)).toEqual(NOTES.filter((p) => p.startsWith('log/')).sort(byCodeUnits))
    const whole = await walk({ recursive: true, budget_tokens: 256 })
    expect(pathsOf(whole)).toEqual([...NOTES].sort(byCodeUnits))
  })

  it('a cursor is bound to `path`, `recursive` and `fields`', async () => {
    const first = await page({ recursive: true, budget_tokens: 256 })
    const cursor = first.truncated !== false ? first.truncated.cursor : null
    expect(cursor).toEqual(expect.any(String))
    for (const other of [{ recursive: false }, { recursive: true, path: 'log' }, { recursive: true, fields: ['path'] }]) {
      const r = await call({ ...other, budget_tokens: 256, cursor })
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/invalid cursor/)
    }
  })
})
