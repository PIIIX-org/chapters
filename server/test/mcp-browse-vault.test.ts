// #425: `browse_vault` lists one level by default, at the root as in a
// folder (notes directly in it, subfolders with their note counts);
// `recursive: true` lists the subtree under `path` (the whole vault without
// it), never the whole vault for a `path`. Items are `{path, title}` unless
// `fields` picks others from an allowlist. Pages come from the database in
// code-unit path order with a keyset, and the cursor is bound to `path`,
// `recursive` and the set of `fields`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { createNote, softDeleteNote } from '../src/notes/store.js'
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
let baseUrl: string
let cookie: string
let agent: Client
let vaultId: string
let foldersVault: string

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
/** Trashed before the tests: never listed or counted; `attic` holds only trashed notes, so it is no subfolder. */
const TRASHED = ['gone', 'docs/gone', 'docs/api/gone', 'attic/old']

/**
 * Root folders in path order with the trailing '/' (`a-b/` < `a/` < `a0/`:
 * '-' < '/' < '0'), between root notes and with nested notes under `a`.
 */
const ROOT_FOLDERS = ['a', 'a-b', 'a0', ...Array.from({ length: 40 }, (_, i) => `f-${String(i).padStart(2, '0')}`)]
const ROOT_FOLDER_NOTES = [
  ...ROOT_FOLDERS.map((f) => `${f}/note`),
  'a/x/deep',
  'a/x/y/deeper',
  ...Array.from({ length: 10 }, (_, i) => `r-${String(i).padStart(2, '0')}`),
  'a-c',
  'f-05x',
]

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'browse-vault-test', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  return client
}

async function mint(body: Args): Promise<string> {
  return (await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body })).json<{ token: string }>().token
}

async function call(args: Args, client = agent): Promise<{ isError: boolean; text: string }> {
  resetRateLimits()
  const result = await client.callTool({ name: 'browse_vault', arguments: client === agent ? { vaultId, ...args } : args })
  const content = result.content as Array<{ type: string; text?: string }>
  return { isError: result.isError === true, text: content.map((c) => c.text ?? '').join('') }
}

async function page(args: Args, client = agent): Promise<Answer> {
  const r = await call(args, client)
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
const cursorOf = (json: Answer): string | null => (json.truncated === false ? null : json.truncated.cursor)

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  const vault = async (name: string) => (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name } })).json<{ id: string }>().id
  vaultId = await vault('browse vault')
  foldersVault = await vault('browse vault folders')
  agent = await connect(await mint({ name: 'browse-vault-agent', scope: 'account' }))
  for (const path of [...NOTES, ...TRASHED]) {
    const frontmatter =
      path === 'docs/intro' ? { title: 'Introduction', tags: ['guide', 'start'], owner: 'x'.repeat(200) } : path === 'docs/setup' ? { title: '' } : {}
    await createNote(vaultId, { path, frontmatter, body: `Body of ${path}.` })
  }
  for (const path of TRASHED) await softDeleteNote(vaultId, path)
  for (const path of ROOT_FOLDER_NOTES) await createNote(foldersVault, { path, body: `Body of ${path}.` })
}, 120_000)

afterAll(async () => {
  await agent?.close().catch(() => {})
  await app?.close()
})

describe('browse_vault one level', () => {
  it('the root with `recursive: false` lists only its own notes and its folders with their counts', async () => {
    const json = await page({ recursive: false, budget_tokens: 25_000 })
    expect(json.truncated).toBe(false)
    expect(json.directory).toBe('')
    expect(json.notes.map((n) => n.path)).toEqual(['docsx', 'readme', 'zeta'])
    // In path order with the trailing '/': `docs-old/` before `docs/`.
    expect(json.subdirectories).toEqual([
      { name: 'docs-old', count: 1 },
      { name: 'docs', count: 5 },
      { name: 'log', count: 30 },
    ])
    expect(json.indexContent).toBeUndefined()
  })

  it('without `recursive` the root is one level too', async () => {
    const json = await page({ budget_tokens: 25_000 })
    expect(json.notes.map((n) => n.path)).toEqual(['docsx', 'readme', 'zeta'])
    expect(json.subdirectories?.map((d) => d.name)).toEqual(['docs-old', 'docs', 'log'])
  })

  it('a folder lists its own notes and subfolders, not its neighbours', async () => {
    const json = await page({ path: 'docs', budget_tokens: 25_000 })
    expect(json.directory).toBe('docs')
    expect(json.notes.map((n) => n.path)).toEqual(['docs/intro', 'docs/setup'])
    expect(json.subdirectories).toEqual([{ name: 'api', count: 3 }])
    expect(json.indexContent).toContain('intro')
    const nested = await page({ path: '/docs/api/', recursive: false, budget_tokens: 25_000 })
    expect(nested.directory).toBe('docs/api')
    expect(nested.notes.map((n) => n.path)).toEqual(['docs/api/auth', 'docs/api/search'])
    expect(nested.subdirectories).toEqual([{ name: 'v2', count: 1 }])
  })

  it('trashed notes are neither listed nor counted, and a folder of trashed notes only is no subfolder', async () => {
    const root = await page({ budget_tokens: 25_000 })
    expect(root.notes.map((n) => n.path)).not.toContain('gone')
    expect(root.subdirectories?.map((d) => d.name)).not.toContain('attic')
    const docs = await page({ path: 'docs', budget_tokens: 25_000 })
    expect(docs.notes.map((n) => n.path)).not.toContain('docs/gone')
    expect(docs.subdirectories).toEqual([{ name: 'api', count: 3 }])
    expect(pathsOf([await page({ recursive: true, budget_tokens: 25_000 })])).toEqual([...NOTES].sort(byCodeUnits))
    expect(await page({ path: 'attic', budget_tokens: 25_000 })).toMatchObject({ subdirectories: [], notes: [] })
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
  it('items are `{path, title}` by default; the title is `frontmatter.title`, else (missing or empty) the name', async () => {
    const json = await page({ path: 'docs', budget_tokens: 25_000 })
    expect(json.notes).toEqual([
      { path: 'docs/intro', title: 'Introduction' },
      { path: 'docs/setup', title: 'setup' },
    ])
    const root = await page({ budget_tokens: 25_000 })
    expect(root.notes[0]).toEqual({ path: 'docsx', title: 'docsx' })
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

  it('root subfolders page by their path: every one once, with its count, then the root notes', async () => {
    const pages = await walk({ vaultId: foldersVault, budget_tokens: 256 })
    expect(pages.length).toBeGreaterThan(2)
    const subdirectories = pages.flatMap((p) => p.subdirectories ?? [])
    const expected = [...ROOT_FOLDERS].sort((a, b) => byCodeUnits(`${a}/`, `${b}/`))
    expect(expected.slice(0, 3)).toEqual(['a-b', 'a', 'a0'])
    expect(subdirectories.map((d) => d.name)).toEqual(expected)
    expect(subdirectories.find((d) => d.name === 'a')).toEqual({ name: 'a', count: 3 })
    expect(subdirectories.filter((d) => d.name !== 'a').every((d) => d.count === 1)).toBe(true)
    expect(pathsOf(pages)).toEqual(ROOT_FOLDER_NOTES.filter((p) => !p.includes('/')).sort(byCodeUnits))
  })

  it('a cursor is bound to `path`, `recursive` and the set of `fields`, not their order', async () => {
    const first = await page({ recursive: true, budget_tokens: 256 })
    const cursor = cursorOf(first)
    expect(cursor).toEqual(expect.any(String))
    for (const other of [{ recursive: false }, { recursive: true, path: 'log' }, { recursive: true, fields: ['path'] }]) {
      const r = await call({ ...other, budget_tokens: 256, cursor })
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/invalid cursor/)
    }
    const picked = await page({ recursive: true, fields: ['title', 'id'], budget_tokens: 256 })
    const next = await page({ recursive: true, fields: ['id', 'title', 'id'], budget_tokens: 256, cursor: cursorOf(picked) })
    expect((next.notes[0]!.path as string) > (picked.notes.at(-1)!.path as string)).toBe(true)
  })
})

describe('browse_vault on a vault-pinned token', () => {
  it('lists its pinned vault without `vaultId`; another vault is refused', async () => {
    const pinned = await connect(await mint({ name: 'browse-vault-pinned', scope: 'vault', vaultId, access: 'read' }))
    try {
      const json = await page({ budget_tokens: 25_000 }, pinned)
      expect(json.notes.map((n) => n.path)).toEqual(['docsx', 'readme', 'zeta'])
      expect((await page({ vaultId, path: 'docs', budget_tokens: 25_000 }, pinned)).notes.map((n) => n.path)).toEqual(['docs/intro', 'docs/setup'])
      // The cursor works with and without the pin's id.
      const first = await page({ recursive: true, budget_tokens: 256 }, pinned)
      const next = await page({ vaultId, recursive: true, budget_tokens: 256, cursor: cursorOf(first) }, pinned)
      expect((next.notes[0]!.path as string) > (first.notes.at(-1)!.path as string)).toBe(true)
      const other = await call({ vaultId: foldersVault }, pinned)
      expect(other.isError).toBe(true)
    } finally {
      await pinned.close().catch(() => {})
    }
  })
})
