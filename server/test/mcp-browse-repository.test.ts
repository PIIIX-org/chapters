// #424: `browse_repository` takes a `path` folder and lists only the files
// under it, a page at a time in path order (`COLLATE "C"`, code units), read
// from the database with a keyset (`path > last`, limit + 1) rather than
// loading the whole repository. The cursor is bound to `path`, and
// `truncated.total` says ">n" when the fetch of limit + 1 found more.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { repositoryFiles } from '../src/db/schema.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Args = Record<string, unknown>
type Truncated =
  | false
  | {
      shown: Record<string, number>
      total: Record<string, number | string>
      dropped: Record<string, number>
      level: string
      cursor: string | null
      narrow: string[]
    }
type Answer = { files: Array<{ path: string; language: string | null; size: number }>; truncated: Truncated }

let app: FastifyInstance
let cookie: string
let agent: Client
let repoId: string
let largeRepoId: string

/** Code-unit order, what `COLLATE "C"` gives whatever the database locale. */
const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const LIB = [
  'src/lib/Z.ts',
  'src/lib/_private.ts',
  'src/lib/a.ts',
  'src/lib/b/c.ts',
  ...Array.from({ length: 30 }, (_, i) => `src/lib/mod-${String(i).padStart(2, '0')}.ts`),
]
/** Neighbours of `src/lib/` a string prefix would match but the folder does not hold. */
const OTHERS = ['README.md', 'docs/guide.md', 'src/lib-extra/d.ts', 'src/lib.ts', 'src/library.ts', 'src/main.ts']
const LARGE = 1_200

async function addFiles(repositoryId: string, paths: string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += 500) {
    await db.insert(repositoryFiles).values(
      paths.slice(i, i + 500).map((path) => ({ repositoryId, path, language: 'typescript', content: `// ${path}`, contentHash: path, size: path.length + 3 })),
    )
  }
}

async function newRepo(name: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name, ingestionMethod: 'agent_push' } })
  return res.json<{ id: string }>().id
}

async function call(args: Args): Promise<{ isError: boolean; text: string }> {
  resetRateLimits()
  const result = await agent.callTool({ name: 'browse_repository', arguments: args })
  const content = result.content as Array<{ type: string; text?: string }>
  return { isError: result.isError === true, text: content.map((c) => c.text ?? '').join('') }
}

/** One answer: within its budget, `truncated` last, shown + dropped = a numeric total. */
async function page(args: Args): Promise<Answer> {
  const r = await call(args)
  expect(r.isError, r.text.slice(0, 300)).toBe(false)
  const budget = typeof args.budget_tokens === 'number' ? args.budget_tokens : 2_000
  expect(Math.ceil(r.text.length / 4), `answer of ${r.text.length} chars over ${budget} tokens`).toBeLessThanOrEqual(budget)
  const json = JSON.parse(r.text) as Answer
  expect(Object.keys(json).at(-1)).toBe('truncated')
  const t = json.truncated
  if (t !== false && typeof t.total.files === 'number') expect(t.shown.files! + t.dropped.files!).toBe(t.total.files)
  return json
}

const cursorOf = (json: Answer): string => {
  if (json.truncated === false || json.truncated.cursor === null) throw new Error(`no cursor in ${JSON.stringify(json).slice(0, 300)}`)
  return json.truncated.cursor
}

/** Follows the cursor to the last page; `between` runs after each page but the last. */
async function walk(args: Args, between?: (n: number) => Promise<void>): Promise<Answer[]> {
  const pages: Answer[] = []
  let cursor: string | null = null
  for (;;) {
    const json = await page({ ...args, ...(cursor ? { cursor } : {}) })
    pages.push(json)
    cursor = json.truncated === false ? null : json.truncated.cursor
    if (cursor === null) return pages
    await between?.(pages.length)
    if (pages.length > 200) throw new Error('never reached the last page')
  }
}

const pathsOf = (pages: Answer[]) => pages.flatMap((p) => p.files.map((f) => f.path))

async function refused(args: Args): Promise<void> {
  const r = await call(args)
  expect(r.isError, r.text.slice(0, 300)).toBe(true)
  expect(r.text).toMatch(/invalid cursor/)
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: 'browse-repo-agent', scope: 'account' } })
  agent = new Client({ name: 'browse-repository-test', version: '0.0.0' })
  await agent.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } },
    }),
  )
  repoId = await newRepo('browse-prefix')
  await addFiles(repoId, [...OTHERS, ...LIB].reverse())
  largeRepoId = await newRepo('browse-large')
  await addFiles(largeRepoId, Array.from({ length: LARGE }, (_, i) => `pkg/m${i % 7}/file-${String(i).padStart(4, '0')}.ts`))
}, 120_000)

afterAll(async () => {
  await agent?.close().catch(() => {})
  await app?.close()
})

describe('browse_repository path filter', () => {
  it('`path` lists only the files under that folder, in code-unit order', async () => {
    const expected = [...LIB].sort(byCodeUnits)
    const json = await page({ repositoryId: repoId, path: 'src/lib', budget_tokens: 25_000 })
    expect(json.truncated).toBe(false)
    expect(json.files.map((f) => f.path)).toEqual(expected)
    expect(json.files[0]).toEqual({ path: 'src/lib/Z.ts', language: 'typescript', size: 'src/lib/Z.ts'.length + 3 })
    // A trailing slash names the same folder; a nested folder lists its own subtree.
    expect((await page({ repositoryId: repoId, path: 'src/lib/', budget_tokens: 25_000 })).files.map((f) => f.path)).toEqual(expected)
    expect((await page({ repositoryId: repoId, path: 'src/lib/b' })).files.map((f) => f.path)).toEqual(['src/lib/b/c.ts'])
    // A folder nothing is under (a file's path included) lists nothing.
    expect(await page({ repositoryId: repoId, path: 'src/main.ts' })).toEqual({ files: [], truncated: false })
    // Without `path`, every file, in the same order.
    const all = await page({ repositoryId: repoId, budget_tokens: 25_000 })
    expect(all.files.map((f) => f.path)).toEqual([...LIB, ...OTHERS].sort(byCodeUnits))
  })
})

describe('browse_repository keyset cursor', () => {
  it('pages follow path order with no gap and no duplicate, with and without `path`', async () => {
    const lib = await walk({ repositoryId: repoId, path: 'src/lib', budget_tokens: 256 })
    expect(lib.length).toBeGreaterThan(1)
    expect(pathsOf(lib)).toEqual([...LIB].sort(byCodeUnits))
    const whole = await walk({ repositoryId: repoId, budget_tokens: 256 })
    expect(whole.length).toBeGreaterThan(lib.length)
    expect(pathsOf(whole)).toEqual([...LIB, ...OTHERS].sort(byCodeUnits))
  })

  it('files added while paging: every earlier file exactly once, a file after the cursor shows up', async () => {
    const grow = await newRepo('browse-grow')
    const initial = Array.from({ length: 40 }, (_, i) => `lib/f-${String(i).padStart(2, '0')}.ts`)
    await addFiles(grow, initial)
    const added: string[] = []
    const pages = await walk({ repositoryId: grow, path: 'lib', budget_tokens: 256 }, async (n) => {
      // One file sorting before everything shown so far, one after everything.
      const before = `lib/a-${n}.ts`
      const after = `lib/z-${n}.ts`
      added.push(after)
      await addFiles(grow, [before, after])
    })
    expect(pages.length).toBeGreaterThan(2)
    const paths = pathsOf(pages)
    expect(new Set(paths).size).toBe(paths.length)
    expect([...paths].sort(byCodeUnits)).toEqual(paths)
    expect(paths).toEqual([...initial, ...added].sort(byCodeUnits))
  })

  it('a cursor is bound to `path`: one from another folder, or from no `path`, is refused', async () => {
    const lib = await page({ repositoryId: repoId, path: 'src/lib', budget_tokens: 256 })
    const whole = await page({ repositoryId: repoId, budget_tokens: 256 })
    await refused({ repositoryId: repoId, path: 'src', budget_tokens: 256, cursor: cursorOf(lib) })
    await refused({ repositoryId: repoId, budget_tokens: 256, cursor: cursorOf(lib) })
    await refused({ repositoryId: repoId, path: 'src/lib', budget_tokens: 256, cursor: cursorOf(whole) })
    // Its own arguments continue, after the last path shown.
    const next = await page({ repositoryId: repoId, path: 'src/lib', budget_tokens: 256, cursor: cursorOf(lib) })
    expect(next.files[0]!.path > lib.files.at(-1)!.path).toBe(true)
  })
})

describe('browse_repository on a large repository', () => {
  it('the default answer stays within 2,000 tokens and reports the total from the limit + 1 fetch', async () => {
    const first = await page({ repositoryId: largeRepoId })
    expect(first.truncated).toMatchObject({ total: { files: '>500' }, cursor: expect.any(String) })
    expect(first.truncated !== false && first.truncated.narrow).toEqual(expect.arrayContaining([expect.stringMatching(/^path: "pkg\/m\d"$/)]))
    // The largest budget still pages at 500 files, and the pages cover the repository once, in order.
    const pages = await walk({ repositoryId: largeRepoId, budget_tokens: 25_000 })
    expect(pages.map((p) => p.files.length)).toEqual([500, 500, 200])
    expect(pages[0]!.truncated).toMatchObject({ shown: { files: 500 }, total: { files: '>500' }, dropped: { files: 0 } })
    const paths = pathsOf(pages)
    expect(new Set(paths).size).toBe(LARGE)
    expect([...paths].sort(byCodeUnits)).toEqual(paths)
  })
})
