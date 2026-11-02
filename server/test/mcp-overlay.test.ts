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
import { createActiveUser, loginCookie } from './helpers.js'

// #676: `find_symbols` takes an overlay, the agent's `git diff --no-renames` against the indexed commit. A symbol
// added only in the overlay is found with its line, one deleted in it is not, the answer names the base commit and
// says an overlay was used, and nothing of it is stored.

const COMMIT = 'fedcba9876543210fedcba9876543210fedcba98'
const STORE = 'export function keep(): number {\n  return 1\n}\n\nexport function doomed(): number {\n  return 2\n}\n'
const OTHER = 'export function untouchedThing(): number {\n  return 3\n}\n'

let app: FastifyInstance
let owner: Client
let stranger: Client
let repoId: string

type Hit = { id: string; path: string; name: string; startLine: number; endLine: number; snippet?: string | null }
type Answer = { commit?: string; overlay?: boolean; results: Hit[] }

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
@@ -1,7 +1,7 @@
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
  const files = { 'src/store.ts': STORE, 'src/other.ts': OTHER }
  await syncRepositoryFiles(repoId, Object.entries(files).map(([path, content]) => ({ path, content })), Object.keys(files), { commit: COMMIT })
  await flushExtraction()
}, 120_000)

afterAll(async () => {
  await owner?.close().catch(() => {})
  await stranger?.close().catch(() => {})
  await app?.close()
})

describe('find_symbols overlay', () => {
  it('finds a symbol added only in the overlay, with its overlay line, and names the base commit', async () => {
    expect((await find('freshlyAdded')).results).toEqual([])
    const json = await find('freshlyAdded', OVERLAY)
    expect(json.commit).toBe(COMMIT)
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

  it('refuses a diff that is not against the indexed content, a malformed one, one with refs, and one without a repository', async () => {
    const wrong = OVERLAY.replace(' export function keep', ' export function other')
    const r = await ask(owner, { query: 'keep', overlay: wrong })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/does not apply to src\/store.ts/)
    expect((await ask(owner, { query: 'keep', overlay: 'nonsense' })).text).toMatch(/no file changes/)
    expect((await ask(owner, { query: 'keep', overlay: OVERLAY, refs: 'callers' })).text).toMatch(/overlay/)
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
})
