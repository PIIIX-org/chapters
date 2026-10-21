// #501: every write kept a full copy of the note in `note_revisions`, so a
// note edited a few hundred times stored a few hundred full copies. Long
// histories are now compacted in the background (a durable job): old
// revisions are stored as a delta from a nearby full revision, losslessly.
// This file uses only what existed before the fix (writes, MCP and REST,
// row sizes in SQL), so on the old code the storage bound fails; the other
// checks prove nothing an agent or an export relies on changed: every
// revision reads back exactly, an edit made from an old (compacted) base
// still merges, the restore point from before the history survives and
// reverts exactly, and a vault export/import round-trip keeps every body.
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import AdmZip from 'adm-zip'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createNote, getLiveNote, updateNote, type Actor } from '../src/notes/store.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Args = Record<string, unknown>

interface HistoryRow {
  id: string
  action: string
  bodyBytes: number
}

const PATH = 'docs/long-history'
const LINES = 400
/** Writes after the create: the agent's first edit, then the person's. */
const WRITES = 200

let app: FastifyInstance
let baseUrl: string
let ownerCookie: string
let vaultId: string
let noteId: string
let person: Actor
let agent: Client
/** Every revision's body in the order recorded, as the test wrote it. */
const expected: Array<{ action: string; body: string }> = []
let lines: string[]

function field(json: unknown, key: string): string {
  const value: unknown = json && typeof json === 'object' && key in json ? Reflect.get(json, key) : undefined
  if (typeof value !== 'string') throw new Error(`expected a string ${key}, got ${JSON.stringify(json)}`)
  return value
}

async function call(name: string, args: Args): Promise<{ isError: boolean; text: string }> {
  resetRateLimits()
  const result = await agent.callTool({ name, arguments: { vaultId, ...args } })
  const content: unknown[] = Array.isArray(result.content) ? result.content : []
  return { isError: result.isError === true, text: content.map((c) => field(c, 'text')).join('') }
}

async function must<T>(name: string, args: Args): Promise<T> {
  const r = await call(name, args)
  if (r.isError) throw new Error(`${name} failed: ${r.text}`)
  return JSON.parse(r.text) as T
}

const line = (i: number) => `line ${String(i).padStart(3, '0')} ${randomBytes(16).toString('hex')}\n`
const text = () => lines.join('')

/** The note's history, newest first, every page. */
async function history(): Promise<HistoryRow[]> {
  const rows: HistoryRow[] = []
  let cursor: string | undefined
  do {
    const page = await must<{ revisions: HistoryRow[]; nextCursor?: string }>('note_history', {
      path: PATH,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    })
    rows.push(...page.revisions)
    cursor = page.nextCursor
  } while (cursor)
  return rows
}

async function revisionBody(id: string): Promise<string> {
  const res = await app.inject({ method: 'GET', url: `/api/vaults/${vaultId}/revisions/${id}`, headers: { cookie: ownerCookie } })
  expect(res.statusCode, res.body).toBe(200)
  return res.json<{ body: string }>().body
}

/** The note's revision rows as stored: how many, and their size on disk (every column). */
async function storage(id: string): Promise<{ rows: number; bytes: number; newest: number }> {
  const [row] = (await db.execute(sql`
    SELECT count(*)::int AS rows, sum(pg_column_size(r.*))::bigint AS bytes,
      (SELECT pg_column_size(n.*) FROM note_revisions n WHERE n.note_id = ${id} ORDER BY n.ord DESC LIMIT 1) AS newest
    FROM note_revisions r WHERE r.note_id = ${id}`)) as unknown as Array<{ rows: number; bytes: string; newest: number }>
  return { rows: row!.rows, bytes: Number(row!.bytes), newest: row!.newest }
}

/** Fails unless some of the note's revisions are stored compacted (an empty `body`, the delta elsewhere). */
async function expectCompacted(): Promise<void> {
  const [row] = (await db.execute(sql`
    SELECT count(*)::int AS n FROM note_revisions WHERE note_id = ${noteId} AND octet_length(body) = 0`)) as unknown as Array<{ n: number }>
  expect(row!.n, 'no revision of the long history is stored compacted').toBeGreaterThan(0)
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  person = { type: 'user', id: owner.id }
  ownerCookie = await loginCookie(app, owner.email)
  const vault = await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie: ownerCookie }, body: { name: 'Long history' } })
  vaultId = field(vault.json(), 'id')
  const minted = await app.inject({
    method: 'POST',
    url: '/api/mcp-connections',
    headers: { cookie: ownerCookie },
    body: { name: 'compaction-agent', scope: 'account' },
  })
  agent = new Client({ name: 'revision-compaction-test', version: '0.0.0' })
  await agent.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${field(minted.json(), 'token')}` } },
    }),
  )

  // A 400-line note (about 18 KB) written 200 times, one line each time.
  lines = Array.from({ length: LINES }, (_, i) => line(i))
  const created = await createNote(vaultId, { path: PATH, frontmatter: { type: 'docs' }, body: text() }, person)
  noteId = created.id
  expected.push({ action: 'create', body: text() })
  // The agent's first write in its session keeps a restore point of the note before it (#482).
  const before = text()
  lines[1] = 'line 001 edited by the agent\n'
  await must('edit_note', { path: PATH, body: text() })
  expected.push({ action: 'restore_point', body: before }, { action: 'update', body: text() })
  for (let i = 1; i < WRITES; i++) {
    lines[10 + ((i * 7) % (LINES - 10))] = line(i)
    await updateNote(vaultId, PATH, { body: text() }, person)
    expected.push({ action: 'update', body: text() })
  }
}, 120_000)

afterAll(async () => {
  await agent?.close()
  await app.close()
})

describe('long revision histories are compacted (#501)', () => {
  it('stores a long history in a fraction of one full copy per revision', async () => {
    const { rows } = await storage(noteId)
    expect(rows).toBe(expected.length)
    // The compaction job runs in the background after the writes.
    await vi.waitFor(
      async () => {
        const now = await storage(noteId)
        // Every revision stored whole would take about `rows` copies of the newest one.
        expect(now.bytes / (now.rows * now.newest)).toBeLessThan(0.35)
      },
      { timeout: 30_000, interval: 250 },
    )
  }, 60_000)

  it('reads every revision back exactly: note_history sizes and get_revision bodies', async () => {
    await expectCompacted()
    const rows = (await history()).reverse()
    expect(rows.map((r) => r.action)).toEqual(expected.map((e) => e.action))
    expect(rows.map((r) => r.bodyBytes)).toEqual(expected.map((e) => Buffer.byteLength(e.body)))
    for (const [i, row] of rows.entries()) expect(await revisionBody(row.id)).toBe(expected[i]!.body)
  }, 60_000)

  it('keeps every revision body through a vault export and import', async () => {
    await expectCompacted()
    const exported = await app.inject({ method: 'GET', url: `/api/vaults/${vaultId}/export`, headers: { cookie: ownerCookie } })
    expect(exported.statusCode).toBe(200)
    const zip = new AdmZip(exported.rawPayload)
    const entry = zip.getEntry(`.elara/history/${noteId}.json`)
    const archived = JSON.parse(entry!.getData().toString('utf8')) as { revisions: Array<{ action: string; body: string }> }
    expect(archived.revisions.map((r) => ({ action: r.action, body: r.body }))).toEqual(expected)

    const boundary = '----compactionboundary'
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="export.zip"\r\ncontent-type: application/zip\r\n\r\n`,
      ),
      exported.rawPayload,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const imported = await app.inject({
      method: 'POST',
      url: '/api/import',
      headers: { cookie: ownerCookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    })
    expect(imported.statusCode, imported.body).toBe(200)
    const copy = await getLiveNote(field(imported.json(), 'vaultId'), PATH)
    const copied = (await db.execute(sql`
      SELECT id FROM note_revisions WHERE note_id = ${copy!.id} ORDER BY ord`)) as unknown as Array<{ id: string }>
    const bodies: Array<{ action: string; body: string }> = []
    for (const { id } of copied) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/vaults/${field(imported.json(), 'vaultId')}/revisions/${id}`,
        headers: { cookie: ownerCookie },
      })
      expect(res.statusCode, res.body).toBe(200)
      const revision = res.json<{ action: string; body: string }>()
      bodies.push({ action: revision.action, body: revision.body })
    }
    expect(bodies).toEqual(expected)
  }, 60_000)

  it('merges an edit_note made from an old, compacted revision (base_rev)', async () => {
    // A revision from early in the history that is now stored as a delta.
    const [old] = (await db.execute(sql`
      SELECT id, seq::int AS seq FROM note_revisions
      WHERE note_id = ${noteId} AND seq IS NOT NULL AND octet_length(body) = 0
      ORDER BY ord LIMIT 1`)) as unknown as Array<{ id: string; seq: number }>
    expect(old, 'no revision of the long history is stored compacted').toBeDefined()
    const base = await must<{ body: string }>('get_revision', { revisionId: old!.id })
    const index = expected.findIndex((e) => e.body === base.body)
    expect(index).toBeGreaterThan(0)

    const mine = base.body.replace(/^line 002 .*$/m, 'line 002 rewritten from an old base')
    const r = await call('edit_note', { path: PATH, base_rev: old!.seq, body: mine })
    expect(r.isError, r.text).toBe(false)
    lines[2] = 'line 002 rewritten from an old base\n'
    expect(JSON.parse(r.text)).toMatchObject({ status: 'merged', baseRev: old!.seq, body: text() })
    expect((await getLiveNote(vaultId, PATH))?.body).toBe(text())
  }, 60_000)

  it('keeps the restore point from before the history, and reverts to it exactly', async () => {
    await expectCompacted()
    const rows = await history()
    const point = rows.find((r) => r.action === 'restore_point')
    expect(point).toBeDefined()
    expect(await revisionBody(point!.id)).toBe(expected[1]!.body)
    await must('revert_note', { path: PATH, revisionId: point!.id })
    expect((await getLiveNote(vaultId, PATH))?.body).toBe(expected[1]!.body)
  }, 60_000)
})
