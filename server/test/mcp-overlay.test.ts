import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { blocks, repositoryFiles } from '../src/db/schema.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { createHash } from 'node:crypto'
import { createActiveUser, loginCookie } from './helpers.js'

// #676: `find_symbols` takes an overlay, the agent's `git diff --no-renames` against the indexed commit. A symbol
// added only in the overlay is found with its line, one deleted in it is not, the answer names the base commit and
// says an overlay was used, and nothing of it is stored.

const COMMIT = 'fedcba9876543210fedcba9876543210fedcba98'
const STORE = 'export function keep(): number {\n  return 1\n}\n\nexport function doomed(): number {\n  return 2\n}\n'
const NOTES = 'plain text, not source\n'
const OTHER = 'export function untouchedThing(): number {\n  return 3\n}\n'

let app: FastifyInstance
let owner: Client
let stranger: Client
let repoId: string

type Hit = { id: string; path: string; name: string; startLine: number; endLine: number; snippet?: string | null }
type Answer = { commit?: string; tree?: string; overlay?: boolean; skipped?: string[]; stale?: string[]; results: Hit[]; truncated: unknown }

async function connect(email: string, name: string, port: number): Promise<Client> {
  const cookie = await loginCookie(app, email)
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name, scope: 'account' } })
  const client = new Client({ name, version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } } }))
  return client
}

async function ask(client: Client, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  resetRateLimits()
  const result = await client.callTool({ name: 'find_symbols', arguments: { repositoryId: repoId, ...args } })
  const content = result.content as Array<{ text?: string }>
  return { isError: result.isError === true, text: content.map((c) => c.text ?? '').join('') }
}

async function find(query: string, overlay?: string, extra: Record<string, unknown> = {}): Promise<Answer> {
  const r = await ask(owner, { query, ...(overlay === undefined ? {} : { overlay }), ...extra })
  expect(r.isError, r.text.slice(0, 300)).toBe(false)
  return JSON.parse(r.text) as Answer
}

// keep gets a new body line and a new function above doomed; doomed is deleted; src/new.ts is added; other.ts untouched.
const OVERLAY = `diff --git a/src/store.ts b/src/store.ts
--- a/src/store.ts
+++ b/src/store.ts
@@ -1,7 +1,6 @@
+export function freshlyAdded(): number {
+  return 9
+}
 export function keep(): number {
   return 1
 }
-
-export function doomed(): number {
-  return 2
-}
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+export function brandNew(): number {
+  return 4
+}
`

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const user = await createActiveUser()
  const cookie = await loginCookie(app, user.email)
  owner = await connect(user.email, 'overlay-owner', port)
  stranger = await connect((await createActiveUser()).email, 'overlay-stranger', port)
  repoId = (await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name: 'overlay-repo', ingestionMethod: 'agent_push' } })).json<{ id: string }>().id
  const files: Record<string, string> = { 'src/store.ts': STORE, 'src/other.ts': OTHER, 'notes.txt': NOTES, 'src/café.ts': 'export function cafeOne(): number {\n  return 1\n}\n' }
  for (let i = 0; i < 4; i++) files[`src/many/checksum${i}.ts`] = `export function checksum${i}(): number {\n  return ${i}\n}\n`
  await syncRepositoryFiles(repoId, Object.entries(files).map(([path, content]) => ({ path, content })), Object.keys(files), { commit: COMMIT })
  await flushExtraction()
}, 120_000)

afterAll(async () => {
  await owner?.close().catch(() => {})
  await stranger?.close().catch(() => {})
  await app?.close()
})

describe('find_symbols overlay', () => {
  it('finds overlay-only symbols at their exact lines and names the actual indexed content tree of an agent push', async () => {
    expect((await find('freshlyAdded')).results).toEqual([])
    const json = await find('freshlyAdded', OVERLAY)
    expect(json.commit).toBeUndefined()
    expect(json.tree).toMatch(/^[0-9a-f]{64}$/)
    expect(json.overlay).toBe(true)
    expect(json.results).toHaveLength(1)
    expect(json.results[0]).toMatchObject({ path: 'src/store.ts', name: 'freshlyAdded', startLine: 1, endLine: 3 })
    const added = await find('brandNew', OVERLAY)
    expect(added.results[0]).toMatchObject({ path: 'src/new.ts', name: 'brandNew', startLine: 1, endLine: 3 })
  })

  it('does not find a symbol the overlay deletes; a symbol that moved is found at its new line', async () => {
    expect((await find('doomed')).results.map((r) => r.name)).toEqual(['doomed'])
    expect((await find('doomed', OVERLAY)).results).toEqual([])
    expect((await find('keep', OVERLAY)).results[0]).toMatchObject({ path: 'src/store.ts', name: 'keep', startLine: 4 })
  })

  it('leaves the base hits of files the overlay does not change, and answers without overlay as before', async () => {
    const json = await find('untouchedThing', OVERLAY)
    expect(json.results.map((r) => [r.path, r.startLine])).toEqual([['src/other.ts', 1]])
    expect((await find('untouchedThing')).overlay).toBeUndefined()
  })

  it('stores nothing: no file, block or version row changes', async () => {
    const files = async () => JSON.stringify(await db.select({ path: repositoryFiles.path, hash: repositoryFiles.contentHash }).from(repositoryFiles).where(eq(repositoryFiles.repositoryId, repoId)))
    const symbolBlocks = async () => (await db.select({ id: blocks.id }).from(blocks).where(eq(blocks.containerId, repoId))).length
    const [f, b] = [await files(), await symbolBlocks()]
    await find('freshlyAdded', OVERLAY)
    expect(await files()).toBe(f)
    expect(await symbolBlocks()).toBe(b)
    expect((await find('freshlyAdded')).results).toEqual([])
  })

  it('refuses malformed or non-applicable diffs and missing repository scope; refs now read the overlay', async () => {
    const wrong = OVERLAY.replace(' export function keep', ' export function other')
    const r = await ask(owner, { query: 'keep', overlay: wrong })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/does not apply to src\/store.ts/)
    expect((await ask(owner, { query: 'keep', overlay: 'nonsense' })).text).toMatch(/no file changes/)
    const refs = await ask(owner, { query: 'keep', overlay: OVERLAY, refs: 'callers' })
    expect(refs.isError, refs.text).toBe(false)
    resetRateLimits()
    expect((await owner.callTool({ name: 'find_symbols', arguments: { query: 'keep', overlay: OVERLAY } })).isError).toBe(true)
  })

  it('answers the same bytes twice, and a stranger is refused as for a missing repository', async () => {
    expect((await ask(owner, { query: 'keep', overlay: OVERLAY })).text).toBe((await ask(owner, { query: 'keep', overlay: OVERLAY })).text)
    const missing = await ask(stranger, { query: 'keep', overlay: OVERLAY, repositoryId: '00000000-0000-4000-8000-000000000000' })
    const real = await ask(stranger, { query: 'keep', overlay: OVERLAY })
    expect(real.isError).toBe(true)
    expect(real.text).toBe(missing.text)
  })

  it('puts what the edit declares before the base hits: with more base matches than the page holds it is still returned', async () => {
    const added = '--- /dev/null\n+++ b/src/added.ts\n@@ -0,0 +1,3 @@\n+export function checksumAdded(): number {\n+  return 5\n+}\n'
    expect((await find('checksum', undefined, { limit: 2 })).results.map((r) => r.name)).not.toContain('checksumAdded')
    const json = await find('checksum', added, { limit: 2 })
    expect(json.results[0]).toMatchObject({ name: 'checksumAdded', path: 'src/added.ts', startLine: 1 })
    expect(json.results).toHaveLength(2)
    expect(json.truncated).not.toBe(false)
  })

  it('honours `kind` and a punctuation-only query matches no overlay symbol', async () => {
    const mixed = '--- /dev/null\n+++ b/src/shapes.ts\n@@ -0,0 +1,4 @@\n+export class Shape {}\n+export function shapeOf(): Shape {\n+  return new Shape()\n+}\n'
    expect((await find('shape', mixed, { kind: 'class' })).results.map((r) => r.name)).toEqual(['Shape'])
    expect((await find('shape', mixed)).results.map((r) => r.name).sort()).toEqual(['Shape', 'shapeOf'])
    expect((await find('. _', mixed)).results).toEqual([])
  })

  it('accepts changed plain text but rejects missing base files instead of silently narrowing the overlay', async () => {
    const plain = '--- a/notes.txt\n+++ b/notes.txt\n@@ -1,1 +1,2 @@\n plain text, not source\n+export function inText() {}\n'
    expect((await find('inText', plain)).results).toEqual([])
    const missing = await ask(owner, { query: 'keep', overlay: plain + '--- a/src/ghost.ts\n+++ b/src/ghost.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n' })
    expect(missing.isError).toBe(true)
    expect(missing.text).toMatch(/base does not match src\/ghost.ts/)
  })

  it('rejects a stale old blob, even when its context would apply', async () => {
    const blob = createHash('sha1').update(`blob ${Buffer.byteLength(STORE)}\0`).update(STORE).digest('hex')
    const withIndex = (id: string) => OVERLAY.replace('--- a/src/store.ts', `index ${id}..abcdef0 100644\n--- a/src/store.ts`)
    expect((await find('keep', withIndex(blob.slice(0, 7)))).stale).toBeUndefined()
    const stale = await ask(owner, { query: 'keep', overlay: withIndex('1234567') })
    expect(stale.isError).toBe(true)
    expect(stale.text).toMatch(/stale overlay base/)
  })

  it('reads at most 2 MiB of changed source in one call', async () => {
    const big = 'x\n'.repeat(350_000)
    const paths = ['src/big1.txt.ts', 'src/big2.txt.ts', 'src/big3.txt.ts'].map((p) => p.replace('.txt', ''))
    await db.insert(repositoryFiles).values(paths.map((path) => ({ repositoryId: repoId, path, language: 'typescript', content: big, contentHash: path, size: big.length })))
    const diff = paths.map((p) => `--- a/${p}\n+++ b/${p}\n@@ -1,1 +1,1 @@\n-x\n+y\n`).join('')
    const r = await ask(owner, { query: 'big', overlay: diff })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/over 2 MiB/)
  })

  it('a modified file with a non-ASCII path, as git quotes it, is found in the index', async () => {
    const diff = '--- "a/src/caf\\303\\251.ts"\n+++ "b/src/caf\\303\\251.ts"\n@@ -1,3 +1,6 @@\n export function cafeOne(): number {\n   return 1\n }\n+export function cafeTwo(): number {\n+  return 2\n+}\n'
    const json = await find('cafeTwo', diff)
    expect(json.skipped).toBeUndefined()
    expect(json.results[0]).toMatchObject({ path: 'src/café.ts', name: 'cafeTwo', startLine: 4 })
  })
})
