// #411: note_history returned every revision with its full body, no limit:
// ~note size x revisions per call (a 900 KiB note passed 50 MB at ~53
// revisions; past ~570 the response exceeded V8's string limit and never
// answered; parallel calls crashed the app). It is now metadata only, newest
// first, a bounded page with an opaque cursor; get_revision returns one
// revision's content, gated exactly like note_history.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { desc, eq } from 'drizzle-orm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { noteRevisions, notes } from '../src/db/schema.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { updateNote } from '../src/notes/store.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Args = Record<string, unknown>

interface HistoryPage {
  revisions: Array<Record<string, unknown> & { id: string; createdAt: string }>
  hasMore: boolean
  nextCursor: string | null
}

const PATH = 'docs/big-history'
const MARK = 'HISTORYBODYMARKER'
const EDITS = 30
/** ~200 KiB per revision: 31 revisions are ~6 MB, which the old tool returned in one response. */
const bodyOf = (i: number) => `${MARK} revision ${i} café\n${'lorem ipsum dolor sit amet '.repeat(7600)}`
const PAGE_BOUND = 64 * 1024

let app: FastifyInstance
let baseUrl: string
let ownerCookie: string
let vaultId: string
let otherVaultId: string
let noteId: string
let owner: Client
let stranger: Client
let viewer: Client
let pinnedElsewhere: Client
const clients: Client[] = []

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'note-history-test', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  )
  clients.push(client)
  return client
}

async function call(client: Client, name: string, args: Args): Promise<{ isError: boolean; text: string }> {
  resetRateLimits()
  try {
    const result = await client.callTool({ name, arguments: args })
    const content = result.content as Array<{ type: string; text?: string }>
    return { isError: result.isError === true, text: content.map((c) => c.text ?? '').join('') }
  } catch (err) {
    return { isError: true, text: String(err) }
  }
}

async function must<T>(client: Client, name: string, args: Args): Promise<T> {
  const r = await call(client, name, args)
  if (r.isError) throw new Error(`${name} failed: ${r.text}`)
  return JSON.parse(r.text) as T
}

/** `json[key]` as a string, or a thrown error naming what came back. */
function field(json: unknown, key: string): string {
  const value: unknown = json && typeof json === 'object' && key in json ? Reflect.get(json, key) : undefined
  if (typeof value !== 'string') throw new Error(`expected a string ${key}, got ${JSON.stringify(json)}`)
  return value
}

async function mint(cookie: string, body: Args): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body })
  if (res.statusCode !== 200) throw new Error(`mint failed: ${res.statusCode} ${res.body}`)
  return field(res.json(), 'token')
}

async function createVault(name: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie: ownerCookie }, body: { name } })
  return field(res.json(), 'id')
}

/** Every revision id of the note, newest first, straight from the table. */
async function revisionIdsInDb(): Promise<string[]> {
  const rows = await db
    .select({ id: noteRevisions.id })
    .from(noteRevisions)
    .where(eq(noteRevisions.noteId, noteId))
    .orderBy(desc(noteRevisions.createdAt), desc(noteRevisions.id))
  return rows.map((r) => r.id)
}

/** Walks note_history to the end with `limit`, returning every page. */
async function allPages(client: Client, limit: number): Promise<HistoryPage[]> {
  const pages: HistoryPage[] = []
  let cursor: string | undefined
  for (;;) {
    const page = await must<HistoryPage>(client, 'note_history', { vaultId, path: PATH, limit, ...(cursor ? { cursor } : {}) })
    pages.push(page)
    if (!page.hasMore) return pages
    expect(page.nextCursor).toEqual(expect.any(String))
    cursor = page.nextCursor!
    if (pages.length > 100) throw new Error('note_history never reached the last page')
  }
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const ownerUser = await createActiveUser()
  const strangerUser = await createActiveUser()
  const viewerUser = await createActiveUser()
  ownerCookie = await loginCookie(app, ownerUser.email)
  vaultId = await createVault('history vault')
  otherVaultId = await createVault('history other vault')
  owner = await mcpClient(await mint(ownerCookie, { name: 'history-owner', scope: 'account' }))
  stranger = await mcpClient(await mint(await loginCookie(app, strangerUser.email), { name: 'history-stranger', scope: 'account' }))
  viewer = await mcpClient(await mint(await loginCookie(app, viewerUser.email), { name: 'history-viewer', scope: 'account' }))
  pinnedElsewhere = await mcpClient(
    await mint(ownerCookie, { name: 'history-pinned-other', scope: 'vault', vaultId: otherVaultId, access: 'read' }),
  )
  await must(owner, 'share_vault', { vaultId, granteeType: 'user', granteeId: viewerUser.id, permission: 'read' })

  noteId = (await must<{ id: string }>(owner, 'create_note', { vaultId, path: PATH, body: bodyOf(0) })).id
  for (let i = 1; i <= EDITS; i++) {
    await updateNote(vaultId, PATH, { body: bodyOf(i) }, { type: 'user', id: ownerUser.id })
  }
  // Revisions recorded in the same instant (one transaction's now()): pages must still split them exactly once.
  const [note] = await db.select({ frontmatter: notes.frontmatter }).from(notes).where(eq(notes.id, noteId))
  const at = new Date(Date.now() - 60_000)
  await db.insert(noteRevisions).values(
    Array.from({ length: 4 }, (_, i) => ({
      noteId,
      actorType: 'collab' as const,
      action: 'update',
      frontmatter: note!.frontmatter as Record<string, unknown>,
      body: `${MARK} tied ${i}`,
      createdAt: at,
    })),
  )
}, 120_000)

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => {})
  await app.close()
})

describe('note_history is metadata only and paginated (#411)', () => {
  it('a note with many large revisions: one bounded page, newest first, no bodies', async () => {
    const r = await call(owner, 'note_history', { vaultId, path: PATH })
    expect(r.isError, r.text.slice(0, 300)).toBe(false)
    expect(r.text.length).toBeLessThan(PAGE_BOUND)
    expect(r.text).not.toContain(MARK)
    const page = JSON.parse(r.text) as HistoryPage
    expect(page.revisions).toHaveLength(20)
    expect(page.hasMore).toBe(true)
    expect(page.nextCursor).toEqual(expect.any(String))

    const ids = await revisionIdsInDb()
    expect(page.revisions.map((rev) => rev.id)).toEqual(ids.slice(0, 20))
    const newest = page.revisions[0]!
    expect(Object.keys(newest).sort()).toEqual(['action', 'actorId', 'actorName', 'actorType', 'bodyBytes', 'createdAt', 'id'])
    expect(newest).toMatchObject({ action: 'update', actorType: 'user', bodyBytes: Buffer.byteLength(bodyOf(EDITS)) })
    const times = page.revisions.map((rev) => Date.parse(rev.createdAt))
    expect(times).toEqual([...times].sort((a, b) => b - a))
  })

  it('the largest page is bounded too', async () => {
    const r = await call(owner, 'note_history', { vaultId, path: PATH, limit: 100 })
    expect(r.isError, r.text.slice(0, 300)).toBe(false)
    expect(r.text.length).toBeLessThan(PAGE_BOUND)
    expect(r.text).not.toContain(MARK)
    const page = JSON.parse(r.text) as HistoryPage
    expect(page.revisions).toHaveLength(EDITS + 1 + 4)
    expect(page).toMatchObject({ hasMore: false, nextCursor: null })
  })

  it('paging returns every revision exactly once, in order, including revisions recorded in the same instant', async () => {
    const ids = await revisionIdsInDb()
    expect(ids).toHaveLength(EDITS + 1 + 4)
    for (const limit of [1, 3, 7]) {
      const pages = await allPages(owner, limit)
      for (const page of pages) expect(page.revisions.length).toBeLessThanOrEqual(limit)
      expect(pages.flatMap((p) => p.revisions.map((rev) => rev.id)), `limit ${limit}`).toEqual(ids)
    }
  })

  it('a revision recorded while paging does not shift the pages', async () => {
    const first = await must<HistoryPage>(owner, 'note_history', { vaultId, path: PATH, limit: 5 })
    await updateNote(vaultId, PATH, { body: `${MARK} written while paging` })
    const second = await must<HistoryPage>(owner, 'note_history', { vaultId, path: PATH, limit: 5, cursor: first.nextCursor })
    const ids = await revisionIdsInDb()
    expect([...first.revisions, ...second.revisions].map((rev) => rev.id)).toEqual(ids.slice(1, 11))
  })

  it('refuses a limit over the maximum and a cursor it did not issue', async () => {
    for (const limit of [0, 101]) {
      const r = await call(owner, 'note_history', { vaultId, path: PATH, limit })
      expect(r.isError, `limit ${limit}`).toBe(true)
    }
    for (const cursor of ['not-a-cursor', Buffer.from('{"t":"x","i":"y"}').toString('base64url')]) {
      const r = await call(owner, 'note_history', { vaultId, path: PATH, cursor })
      expect(r.isError, cursor).toBe(true)
      expect(r.text).toMatch(/invalid cursor/)
    }
  })

  it('refuses a well-formed cursor with an impossible time before it reaches the database', async () => {
    const id = randomUUID()
    for (const at of [
      '2026-02-30T00:00:00.000000Z',
      '0000-01-01T00:00:00.000000Z',
      '2026-13-01T00:00:00.000000Z',
      '2026-01-01T24:00:00.000000Z',
    ]) {
      const cursor = Buffer.from(JSON.stringify({ at, id })).toString('base64url')
      const r = await call(owner, 'note_history', { vaultId, path: PATH, cursor })
      expect(r.isError, at).toBe(true)
      expect(r.text, at).toMatch(/invalid cursor/)
      expect(r.text, at).not.toMatch(/Failed query|select/i)
    }
    // The earliest and latest times the cursor format can carry are accepted.
    for (const at of ['0001-01-01T00:00:00.000000Z', '9999-12-31T23:59:59.999999Z']) {
      const cursor = Buffer.from(JSON.stringify({ at, id })).toString('base64url')
      const r = await call(owner, 'note_history', { vaultId, path: PATH, cursor })
      expect(r.isError, `${at}: ${r.text.slice(0, 200)}`).toBe(false)
    }
  })
})

describe('get_revision returns one revision with its content (#411)', () => {
  it('returns the body and frontmatter of the revision note_history names', async () => {
    const pages = await allPages(owner, 100)
    const all = pages.flatMap((p) => p.revisions)
    const created = all.find((rev) => rev.action === 'create')!
    const rev = await must<Record<string, unknown>>(owner, 'get_revision', { vaultId, revisionId: created.id })
    expect(rev).toMatchObject({
      id: created.id,
      noteId,
      path: PATH,
      action: 'create',
      body: bodyOf(0),
      frontmatter: expect.objectContaining({ type: 'docs' }),
    })
    // Naming the note by path or id narrows the lookup; it must match.
    expect((await must<{ body: string }>(owner, 'get_revision', { vaultId, path: PATH, revisionId: created.id })).body).toBe(bodyOf(0))
    expect((await must<{ body: string }>(owner, 'get_revision', { vaultId, noteId, revisionId: created.id })).body).toBe(bodyOf(0))
    // The path is read like every note tool reads it: trimmed, `\` as `/`, a trailing `.md` dropped.
    for (const path of [`${PATH}.md`, ` ${PATH} `, PATH.replace('/', '\\')]) {
      const r = await call(owner, 'get_revision', { vaultId, path, revisionId: created.id })
      expect(r.isError, `${JSON.stringify(path)}: ${r.text.slice(0, 200)}`).toBe(false)
      expect((await call(owner, 'note_history', { vaultId, path, limit: 1 })).isError, JSON.stringify(path)).toBe(false)
    }
    for (const args of [
      { vaultId, path: 'docs/some-other-note', revisionId: created.id },
      { vaultId, noteId: randomUUID(), revisionId: created.id },
      { vaultId, revisionId: randomUUID() },
    ]) {
      const r = await call(owner, 'get_revision', args)
      expect(r.isError, JSON.stringify(args)).toBe(true)
      expect(r.text).toMatch(/revision not found/)
    }
  })

  it('is refused like note_history: another user, a read-only share, a token pinned to another vault', async () => {
    const revisionId = (await revisionIdsInDb()).at(-1)!
    // A read share does not reach history (audit rule: history needs edit).
    for (const client of [stranger, viewer]) {
      for (const [tool, args] of [
        ['note_history', { vaultId, path: PATH }],
        ['get_revision', { vaultId, revisionId }],
        ['get_revision', { vaultId, path: PATH, revisionId }],
      ] as const) {
        const r = await call(client, tool, args)
        expect(r.isError, `${tool}: ${r.text}`).toBe(true)
        expect(r.text).not.toContain(MARK)
      }
    }
    // Pinned to another vault: naming this vault is a scope refusal; omitting it stays inside the pin.
    const named = await call(pinnedElsewhere, 'get_revision', { vaultId, revisionId })
    expect(named.isError).toBe(true)
    expect(named.text).toMatch(/pinned to a different vault/)
    const confined = await call(pinnedElsewhere, 'get_revision', { revisionId })
    expect(confined.isError).toBe(true)
    expect(confined.text).toMatch(/revision not found/)
    expect(confined.text).not.toContain(MARK)
  })
})
