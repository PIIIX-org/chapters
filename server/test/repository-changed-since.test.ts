import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { repositoryChanges, repositoryVersions } from '../src/db/schema.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { VERSIONS_KEPT, syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { createActiveUser, loginCookie } from './helpers.js'

// #471: `browse_repository` with `changed_since` lists the files changed since a commit or a date, from the index's
// own version history (one version per sync that changed files or the commit; the first is the baseline).

const C1 = '1111111111111111111111111111111111111111'
const C2 = '2222222222222222222222222222222222222222'
const C3 = '3333333333333333333333333333333333333333'

let app: FastifyInstance
let cookie: string
let agent: Client
let other: Client
let repoId: string

type Entry = { path: string; kind: string; language?: string | null; size?: number }
type Answer = { commit?: string; since?: { commit?: string; at: string }; files: Entry[]; truncated: unknown }

async function connect(email: string, name: string, port: number): Promise<Client> {
  const login = await loginCookie(app, email)
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie: login }, body: { name, scope: 'account' } })
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
  const result = await client.callTool({ name: 'browse_repository', arguments: args })
  const content = result.content as Array<{ text?: string }>
  return { isError: result.isError === true, text: content.map((c) => c.text ?? '').join('') }
}

async function changed(args: Record<string, unknown>): Promise<Answer> {
  const r = await ask(agent, { repositoryId: repoId, ...args })
  expect(r.isError, r.text.slice(0, 300)).toBe(false)
  return JSON.parse(r.text) as Answer
}

const file = (path: string, content: string) => ({ path, content })

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  const stranger = await createActiveUser()
  agent = await connect(owner.email, 'changed-since-agent', port)
  other = await connect(stranger.email, 'changed-since-stranger', port)
  const res = await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name: 'changed-since', ingestionMethod: 'agent_push' } })
  repoId = res.json<{ id: string }>().id

  // v1 (C1, baseline): a, b, src/c. v2 (C2): a modified, d added, b deleted. v3 (C3): d deleted, e added, src/c modified.
  await syncRepositoryFiles(repoId, [file('a.ts', 'one'), file('b.ts', 'one'), file('src/c.ts', 'one')], ['a.ts', 'b.ts', 'src/c.ts'], { commit: C1 })
  await syncRepositoryFiles(repoId, [file('a.ts', 'two'), file('d.ts', 'one')], ['a.ts', 'd.ts', 'src/c.ts'], { commit: C2 })
  await syncRepositoryFiles(repoId, [file('e.ts', 'one'), file('src/c.ts', 'two')], ['a.ts', 'e.ts', 'src/c.ts'], { commit: C3 })
  await flushExtraction()
  // Version times a date can name: v1 a day ago, v2 an hour ago, v3 now.
  const day = 24 * 3600 * 1000
  await db.update(repositoryVersions).set({ indexedAt: new Date(Date.now() - day) }).where(eq(repositoryVersions.seq, 1))
  await db.update(repositoryVersions).set({ indexedAt: new Date(Date.now() - 3600 * 1000) }).where(eq(repositoryVersions.seq, 2))
}, 120_000)

afterAll(async () => {
  await agent?.close().catch(() => {})
  await other?.close().catch(() => {})
  await app?.close()
})

describe('browse_repository changed_since', () => {
  it('since the baseline commit: every change after it, folded per path, with the indexed commit in the head', async () => {
    const json = await changed({ changed_since: C1 })
    // d was added in v2 and deleted in v3: nothing. b was deleted; a and src/c were modified; e is new.
    expect(json.files.map((f) => [f.path, f.kind])).toEqual([
      ['a.ts', 'modified'],
      ['b.ts', 'deleted'],
      ['e.ts', 'added'],
      ['src/c.ts', 'modified'],
    ])
    expect(json.commit).toBe(C3)
    expect(json.since?.commit).toBe(C1)
    expect(json.files[0]).toMatchObject({ language: 'typescript', size: 3 })
    expect(json.files[1]).not.toHaveProperty('size')
  })

  it('a commit prefix names the commit; the newest commit has nothing after it', async () => {
    expect((await changed({ changed_since: C2.slice(0, 7) })).files.map((f) => [f.path, f.kind])).toEqual([
      ['d.ts', 'deleted'],
      ['e.ts', 'added'],
      ['src/c.ts', 'modified'],
    ])
    expect((await changed({ changed_since: C3 })).files).toEqual([])
  })

  it('a date names the newest version indexed at or before it', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString()
    const json = await changed({ changed_since: twoHoursAgo })
    expect(json.since?.commit).toBe(C1)
    expect(json.files.map((f) => f.path)).toEqual(['a.ts', 'b.ts', 'e.ts', 'src/c.ts'])
    const recent = await changed({ changed_since: new Date(Date.now() - 1800 * 1000).toISOString() })
    expect(recent.since?.commit).toBe(C2)
    expect(recent.files.map((f) => f.path)).toEqual(['d.ts', 'e.ts', 'src/c.ts'])
  })

  it('a date before the first version says the history starts later (`since: null`, `historyStartsAt`), and lists the changes after it; `path` narrows to a folder', async () => {
    const before = (await changed({ changed_since: '2000-01-01' })) as Answer & { historyStartsAt?: string }
    expect(before.since).toBeNull()
    expect(before.historyStartsAt).toBe((await db.select().from(repositoryVersions).where(eq(repositoryVersions.seq, 1)))[0]!.indexedAt.toISOString())
    expect(before.files.map((f) => f.path)).toEqual(['a.ts', 'b.ts', 'e.ts', 'src/c.ts'])
    const json = await changed({ changed_since: C1, path: 'src' })
    expect(json.files.map((f) => f.path)).toEqual(['src/c.ts'])
  })

  it('a date-time without an offset is UTC, whatever the server TZ', async () => {
    const hourAgo = new Date(Date.now() - 1800 * 1000).toISOString().slice(0, 19)
    const bare = await changed({ changed_since: hourAgo })
    const zoned = await changed({ changed_since: `${hourAgo}Z` })
    expect(bare.since).toEqual(zoned.since)
    expect(bare.since?.commit).toBe(C2)
  })

  it('refuses a commit it never indexed and a value that is neither a commit nor a date', async () => {
    const unknown = await ask(agent, { repositoryId: repoId, changed_since: 'deadbeef' })
    expect(unknown.isError).toBe(true)
    expect(unknown.text).toMatch(/commit not in the index history/)
    const junk = await ask(agent, { repositoryId: repoId, changed_since: 'last tuesday' })
    expect(junk.isError).toBe(true)
    expect(junk.text).toMatch(/commit SHA/)
  })

  it('is refused for an account that cannot read the repository, like the plain listing', async () => {
    const plain = await ask(other, { repositoryId: repoId })
    const since = await ask(other, { repositoryId: repoId, changed_since: C1 })
    expect(since.isError).toBe(true)
    expect(since.text).toBe(plain.text)
  })

  it('stays within its budget and pages with a cursor when a sync changes many files', async () => {
    const paths = Array.from({ length: 620 }, (_, i) => `many/f${String(i).padStart(4, '0')}.ts`)
    await syncRepositoryFiles(repoId, paths.map((p) => file(p, p)), ['a.ts', 'e.ts', 'src/c.ts', ...paths], { commit: 'c'.repeat(40) })
    const first = await ask(agent, { repositoryId: repoId, changed_since: C3, budget_tokens: 25_000 })
    const page1 = JSON.parse(first.text) as Answer & { truncated: { cursor: string; total: Record<string, number | string>; shown: Record<string, number> } }
    expect(page1.files).toHaveLength(500)
    expect(page1.truncated.cursor).toBeTruthy()
    const second = JSON.parse((await ask(agent, { repositoryId: repoId, changed_since: C3, budget_tokens: 25_000, cursor: page1.truncated.cursor })).text) as Answer
    expect([...page1.files, ...second.files].map((f) => f.path)).toEqual(paths)
    expect(second.truncated).toBe(false)
  })

  it('a sync that stops midway leaves its changes for the next one: nothing is lost from the history', async () => {
    const R = await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name: 'changed-since-stopped', ingestionMethod: 'agent_push' } })
    const id = R.json<{ id: string }>().id
    await syncRepositoryFiles(id, [file('x.ts', 'one'), file('y.ts', 'one')], ['x.ts', 'y.ts'], { commit: C1 })
    const broken = { path: 'z.ts', get content(): string { throw new Error('connection lost') } }
    await expect(syncRepositoryFiles(id, [file('x.ts', 'two'), file('w.ts', 'new'), broken], ['x.ts', 'y.ts', 'w.ts', 'z.ts'], { commit: C2 })).rejects.toThrow('connection lost')
    // Retried: x and w are already written, so this sync changes only z; all three are version 2's changes.
    await syncRepositoryFiles(id, [file('x.ts', 'two'), file('w.ts', 'new'), file('z.ts', 'new')], ['x.ts', 'y.ts', 'w.ts', 'z.ts'], { commit: C2 })
    const r = await ask(agent, { repositoryId: id, changed_since: C1 })
    expect((JSON.parse(r.text) as Answer).files.map((f) => [f.path, f.kind])).toEqual([['w.ts', 'added'], ['x.ts', 'modified'], ['z.ts', 'added']])
  })

  it('keeps the last VERSIONS_KEPT versions and their changes', async () => {
    const R = await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body: { name: 'changed-since-pruned', ingestionMethod: 'agent_push' } })
    const id = R.json<{ id: string }>().id
    const paths: string[] = []
    for (let i = 0; i < VERSIONS_KEPT + 3; i += 1) {
      paths.push(`p${i}.ts`)
      await syncRepositoryFiles(id, [file(`p${i}.ts`, 'x')], [...paths])
    }
    const versions = await db.select().from(repositoryVersions).where(eq(repositoryVersions.repositoryId, id))
    expect(versions).toHaveLength(VERSIONS_KEPT)
    expect(Math.min(...versions.map((v) => v.seq))).toBe(4)
    const changes = await db.select().from(repositoryChanges).where(eq(repositoryChanges.repositoryId, id))
    expect(changes).toHaveLength(VERSIONS_KEPT)
  }, 120_000)

  it('an unchanged sync records no version; an empty commit-only sync records one with no changes', async () => {
    const before = await db.select().from(repositoryVersions).where(eq(repositoryVersions.repositoryId, repoId))
    await syncRepositoryFiles(repoId, [], ['a.ts', 'e.ts', 'src/c.ts', ...Array.from({ length: 620 }, (_, i) => `many/f${String(i).padStart(4, '0')}.ts`)], { commit: 'c'.repeat(40) })
    expect(await db.select().from(repositoryVersions).where(eq(repositoryVersions.repositoryId, repoId))).toHaveLength(before.length)
    await syncRepositoryFiles(repoId, [], ['a.ts', 'e.ts', 'src/c.ts', ...Array.from({ length: 620 }, (_, i) => `many/f${String(i).padStart(4, '0')}.ts`)], { commit: 'd'.repeat(40) })
    expect(await db.select().from(repositoryVersions).where(eq(repositoryVersions.repositoryId, repoId))).toHaveLength(before.length + 1)
    expect((await changed({ changed_since: 'c'.repeat(40) })).files).toEqual([])
  })
})
