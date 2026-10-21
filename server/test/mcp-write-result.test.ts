// ADR-003 S4.
//
// #474: read_note served the stored row, which lags the editor by the relay's
// store debounce (2-10 s), so an agent read text without the person's latest
// typing and then wrote it back whole (#408). read_note now folds the relay's
// loaded document into the store first (one revision per fold, Q8) and serves
// that, with `rev` = the note's `seq`.
//
// #477: every write answers `{rev, status, diff_stats, concurrent_changes,
// indexed}`, takes an `idempotency_key` (the same key and arguments again
// return the first result and write nothing) and `dry_run` (the result without
// writing); a write the store refuses as busy answers `status: "retry"`.
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { eq } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { db, sql } from '../src/db/client.js'
import { noteRevisions, writeIdempotency } from '../src/db/schema.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { getLiveNote } from '../src/notes/store.js'
import { INSTANCE_LOCK_KEY } from '../src/notes/store-tx.js'
import { FailpointError, setFailpointHandler } from '../src/failpoints.js'
import { startCollabServer, type CollabRelay } from '../src/sync/collab-server.js'
import { createActiveUser, loginCookie, loginToken, noteDocName } from './helpers.js'

type Args = Record<string, unknown>

interface WriteResult {
  rev: number | null
  status: 'applied' | 'merged' | 'conflicted' | 'retry'
  diff_stats: { lines_added: number; lines_removed: number; frontmatter_keys: string[] } | null
  concurrent_changes: unknown
  indexed: boolean
  dry_run?: boolean
  replayed?: boolean
  body?: string
  path?: string
  proposalId?: string | null
}

let app: FastifyInstance
let collab: CollabRelay
let baseUrl: string
let ownerToken: string
let cookie: string
let vaultId: string
let mcp: Client
const clients: Client[] = []
const providers: HocuspocusProvider[] = []

async function connect(name: string): Promise<Client> {
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name, scope: 'account' } })
  const client = new Client({ name: `${name}-test`, version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } },
    }),
  )
  clients.push(client)
  return client
}

async function call(name: string, args: Args, client = mcp): Promise<{ isError: boolean; text: string }> {
  resetRateLimits()
  const result = await client.callTool({ name, arguments: args })
  const content = result.content as Array<{ type: string; text?: string }>
  return { isError: result.isError === true, text: content.map((c) => c.text ?? '').join('') }
}

async function must<T>(name: string, args: Args, client = mcp): Promise<T> {
  const r = await call(name, args, client)
  if (r.isError) throw new Error(`${name} failed: ${r.text}`)
  return JSON.parse(r.text) as T
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await sleep(25)
  }
}

/** Document names of the notes opened, by path (`<vault>/~<noteId>`, ADR-003 §5.4). */
const docNames = new Map<string, string>()

async function open(path: string): Promise<HocuspocusProvider> {
  const name = await noteDocName(vaultId, path)
  docNames.set(path, name)
  const provider = new HocuspocusProvider({
    url: `${baseUrl.replace('http', 'ws')}/collab`,
    name,
    token: ownerToken,
    document: new Y.Doc(),
  })
  providers.push(provider)
  return provider
}

function liveBody(path: string): string | undefined {
  return collab.hocuspocus.documents.get(docNames.get(path) ?? '')?.getText('body').toString()
}

async function seqOf(path: string): Promise<number> {
  const row = await getLiveNote(vaultId, path)
  const [found] = await sql<Array<{ seq: string }>>`SELECT seq::text FROM notes WHERE id = ${row!.id}`
  return Number(found!.seq)
}

async function revisionCount(path: string): Promise<number> {
  const row = await getLiveNote(vaultId, path)
  return (await db.select({ id: noteRevisions.id }).from(noteRevisions).where(eq(noteRevisions.noteId, row!.id))).length
}

const BODY = 'Para one.\n\nPara two.\n\nPara three.\n'

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}`
  collab = startCollabServer(app.server)
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  ownerToken = await loginToken(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'Write result' } })).json<{ id: string }>().id
  mcp = await connect('write-result')
})

afterAll(async () => {
  providers.forEach((p) => p.destroy())
  for (const client of clients) await client.close()
  await collab.destroy()
  await app.close()
})

describe('read_note serves the live document (#474)', () => {
  it('returns typing the relay holds but has not stored yet, as a revision at rev = seq', async () => {
    const path = 'docs/live-read'
    await must('create_note', { vaultId, path, body: BODY })
    const text = (await open(path)).document.getText('body')
    await waitFor(() => text.toString() === BODY && liveBody(path) === BODY)

    text.insert(text.toString().indexOf('two.'), 'TYPED ')
    const typed = text.toString()
    await waitFor(() => liveBody(path) === typed)
    // Well inside the 2 s store debounce: the row still has the old text.
    expect((await getLiveNote(vaultId, path))!.body).toBe(BODY)

    const read = await must<{ body: string; rev: number; indexed: boolean }>('read_note', { vaultId, path })
    expect(read.body).toBe(typed)
    expect(read.rev).toBe(await seqOf(path))
    expect(typeof read.indexed).toBe('boolean')
    // The fold is a revision of the editors at that seq (I2), and the row holds it.
    const row = await getLiveNote(vaultId, path)
    expect(row!.body).toBe(typed)
    const [atSeq] = await sql<Array<{ body: string }>>`SELECT body FROM note_revisions WHERE note_id = ${row!.id} AND seq = ${read.rev}`
    expect(atSeq?.body).toBe(typed)

    // A second read with nothing new writes nothing.
    const count = await revisionCount(path)
    expect((await must<{ rev: number }>('read_note', { vaultId, path })).rev).toBe(read.rev)
    expect(await revisionCount(path)).toBe(count)
  })

  it('a read that cannot store the typing first (store busy) fails as a read, not a write', async () => {
    const path = 'docs/live-busy'
    await must('create_note', { vaultId, path, body: BODY })
    const text = (await open(path)).document.getText('body')
    await waitFor(() => text.toString() === BODY && liveBody(path) === BODY)
    text.insert(0, 'TYPED ')
    await waitFor(() => liveBody(path)!.startsWith('TYPED'))
    const held = await sql.reserve()
    try {
      await held`SELECT pg_advisory_lock(${INSTANCE_LOCK_KEY.toString()}::bigint)`
      const r = await call('read_note', { vaultId, path })
      expect(r.isError).toBe(true)
      expect(r.text).toContain('retry the read')
      expect(r.text).not.toContain('nothing was written')
    } finally {
      await held`SELECT pg_advisory_unlock(${INSTANCE_LOCK_KEY.toString()}::bigint)`
      held.release()
    }
    expect((await must<{ body: string }>('read_note', { vaultId, path })).body.startsWith('TYPED')).toBe(true)
  })

  it('REST GET serves the live document too, with rev', async () => {
    const path = 'docs/live-rest'
    await must('create_note', { vaultId, path, body: BODY })
    const text = (await open(path)).document.getText('body')
    await waitFor(() => text.toString() === BODY && liveBody(path) === BODY)
    text.insert(0, 'TYPED ')
    const typed = text.toString()
    await waitFor(() => liveBody(path) === typed)
    const res = await app.inject({ method: 'GET', url: `/api/vaults/${vaultId}/notes/${path}`, headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ body: typed, rev: await seqOf(path) })
  })

  it('an agent that reads, then writes the whole body back, keeps the typing (#408)', async () => {
    const path = 'docs/live-write-back'
    await must('create_note', { vaultId, path, body: BODY })
    const text = (await open(path)).document.getText('body')
    await waitFor(() => text.toString() === BODY && liveBody(path) === BODY)
    text.insert(text.toString().indexOf('one.'), 'TYPED ')
    await waitFor(() => liveBody(path)!.includes('TYPED'))

    const read = await must<{ body: string }>('read_note', { vaultId, path })
    await must('edit_note', { vaultId, path, body: `${read.body}Agent line.\n` })
    await waitFor(async () => (await getLiveNote(vaultId, path))!.body === 'Para TYPED one.\n\nPara two.\n\nPara three.\nAgent line.\n')
  })
})

describe('write results (#477)', () => {
  it('edit_note answers rev = seq, status, diff_stats, concurrent_changes and indexed', async () => {
    const path = 'docs/result-edit'
    const created = await must<WriteResult>('create_note', { vaultId, path, body: BODY })
    expect(created).toMatchObject({ rev: 1, status: 'applied', indexed: false, concurrent_changes: null })
    expect(created.diff_stats).toEqual({ lines_added: 5, lines_removed: 0, frontmatter_keys: expect.arrayContaining(['type']) })

    const edited = await must<WriteResult>('edit_note', { vaultId, path, body: BODY.replace('Para two.', 'Para 2.'), frontmatter: { status: 'draft' } })
    expect(edited).toMatchObject({ status: 'applied', indexed: false, concurrent_changes: null })
    expect(edited.rev).toBe(await seqOf(path))
    expect(edited.rev).toBeGreaterThan(1)
    expect(edited.diff_stats).toEqual({ lines_added: 1, lines_removed: 1, frontmatter_keys: ['status'] })
  })

  it('base_rev takes a seq (rev) or a revision id; a merged edit lists concurrent_changes', async () => {
    const path = 'docs/result-base'
    await must('create_note', { vaultId, path, body: BODY })
    const read = await must<{ rev: number; body: string }>('read_note', { vaultId, path })
    expect(typeof read.rev).toBe('number')
    await must('edit_note', { vaultId, path, ops: [{ op: 'replace_text', find: 'Para one.', replace: 'Para ONE.' }] })

    const merged = await must<WriteResult>('edit_note', { vaultId, path, base_rev: read.rev, body: read.body.replace('Para three.', 'Para 3.') })
    expect(merged).toMatchObject({ status: 'merged', body: 'Para ONE.\n\nPara two.\n\nPara 3.\n', concurrent_changes: { lines: [{ line: 1, removed: 1, added: 1 }] } })

    const history = await must<{ revisions: Array<{ id: string }> }>('note_history', { vaultId, path })
    const byId = await must<WriteResult>('edit_note', { vaultId, path, base_rev: history.revisions[0]!.id, body: 'Para ONE.\n\nPara two.\n\nPara 3!\n' })
    expect(byId.status).toBe('applied')

    const unknown = await call('edit_note', { vaultId, path, base_rev: 999 })
    expect(unknown.isError).toBe(true)
    expect(unknown.text).toContain('base_rev 999 is not a revision')
  })

  it('the same idempotency_key and arguments return the first result and write once', async () => {
    const path = 'docs/result-idem'
    await must('create_note', { vaultId, path, body: BODY, idempotency_key: 'create-idem-1' })
    const again = await must<WriteResult>('create_note', { vaultId, path, body: BODY, idempotency_key: 'create-idem-1' })
    expect(again).toMatchObject({ rev: 1, status: 'applied', replayed: true })

    const args = { vaultId, path, text: 'appended once', idempotency_key: 'append-idem-1' }
    const first = await must<WriteResult>('append_note', args)
    const second = await must<WriteResult>('append_note', args)
    expect(second).toMatchObject({ rev: first.rev, status: first.status, replayed: true })
    expect((await getLiveNote(vaultId, path))!.body.match(/appended once/g)).toHaveLength(1)

    // Stored durably, per connection and key.
    const stored = await db.select().from(writeIdempotency).where(eq(writeIdempotency.key, 'append-idem-1'))
    expect(stored).toHaveLength(1)

    // The same key with other arguments is refused, nothing written.
    const other = await call('append_note', { ...args, text: 'something else' })
    expect(other.isError).toBe(true)
    expect(other.text).toContain('idempotency_key')
    expect((await getLiveNote(vaultId, path))!.body).not.toContain('something else')

    // Keys are per connection: another connection's same key is its own write.
    const otherClient = await connect('write-result-2')
    const theirs = await must<WriteResult>('append_note', args, otherClient)
    expect(theirs.replayed).toBeUndefined()
    expect((await getLiveNote(vaultId, path))!.body.match(/appended once/g)).toHaveLength(2)
  })

  it('dry_run computes the result without writing', async () => {
    const path = 'docs/result-dry'
    await must('create_note', { vaultId, path, body: BODY })
    const seq = await seqOf(path)
    const count = await revisionCount(path)

    const dry = await must<WriteResult>('edit_note', { vaultId, path, body: BODY.replace('Para two.', 'Para 2.'), dry_run: true })
    expect(dry).toMatchObject({ dry_run: true, status: 'applied', rev: seq, body: BODY.replace('Para two.', 'Para 2.') })
    expect(dry.diff_stats).toEqual({ lines_added: 1, lines_removed: 1, frontmatter_keys: [] })

    const read = await must<{ rev: number; body: string }>('read_note', { vaultId, path })
    await must('edit_note', { vaultId, path, ops: [{ op: 'replace_text', find: 'Para two.', replace: 'Para TWO.' }] })
    const conflicted = await must<WriteResult>('edit_note', { vaultId, path, base_rev: read.rev, body: read.body.replace('Para two.', 'Para dos.'), dry_run: true })
    expect(conflicted).toMatchObject({ dry_run: true, status: 'conflicted', proposalId: null })

    const appended = await must<WriteResult>('append_note', { vaultId, path, text: 'dry line', dry_run: true })
    expect(appended).toMatchObject({ dry_run: true, status: 'applied' })
    const reverted = await must<WriteResult>('revert_note', { vaultId, path, revisionId: (await must<{ revisions: Array<{ id: string }> }>('note_history', { vaultId, path })).revisions.at(-1)!.id, dry_run: true })
    expect(reverted).toMatchObject({ dry_run: true, status: 'applied', body: BODY })

    const created = await must<WriteResult>('create_note', { vaultId, path: 'docs/result-dry-new', body: 'x\n', dry_run: true })
    expect(created).toMatchObject({ dry_run: true, status: 'applied', rev: 1 })
    expect(await getLiveNote(vaultId, 'docs/result-dry-new')).toBeNull()
    const exists = await call('create_note', { vaultId, path, body: 'x\n', dry_run: true })
    expect(exists.isError).toBe(true)

    // Nothing but the one real edit was written.
    expect(await seqOf(path)).toBe(seq + 1)
    expect(await revisionCount(path)).toBe(count + 1)
    expect((await getLiveNote(vaultId, path))!.body).not.toContain('dry line')
  })

  it('a write the store refuses as busy answers status "retry" and writes nothing', async () => {
    const path = 'docs/result-retry'
    await must('create_note', { vaultId, path, body: BODY })
    const seq = await seqOf(path)
    const held = await sql.reserve()
    try {
      await held`SELECT pg_advisory_lock(${INSTANCE_LOCK_KEY.toString()}::bigint)`
      const r = await must<WriteResult>('edit_note', { vaultId, path, body: 'changed\n', idempotency_key: 'retry-1' })
      expect(r).toMatchObject({ status: 'retry', rev: null })
    } finally {
      await held`SELECT pg_advisory_unlock(${INSTANCE_LOCK_KEY.toString()}::bigint)`
      held.release()
    }
    expect(await seqOf(path)).toBe(seq)
    // A retry is not kept: the same key then writes.
    const retried = await must<WriteResult>('edit_note', { vaultId, path, body: 'changed\n', idempotency_key: 'retry-1' })
    expect(retried).toMatchObject({ status: 'applied', rev: seq + 1 })
    expect(retried.replayed).toBeUndefined()
  })

  describe('idempotency_key across a crash after COMMIT (ADR-003 §4, §10)', () => {
    afterEach(() => setFailpointHandler(null))

    it('a write that committed but never answered is replayed by its key, not written again', async () => {
      const path = 'docs/result-crash'
      await must('create_note', { vaultId, path, body: BODY })
      const args = { vaultId, path, text: 'exactly once', idempotency_key: 'crash-1' }
      // The crash-write lab SIGKILLs here: committed, no answer sent.
      setFailpointHandler((point) => {
        if (point === 'edit.after-commit-before-ack') throw new FailpointError(point)
      })
      const crashed = await call('append_note', args)
      expect(crashed.isError).toBe(true)
      setFailpointHandler(null)

      const retried = await must<WriteResult>('append_note', args)
      expect(retried).toMatchObject({ status: 'applied', replayed: true, rev: await seqOf(path) })
      expect((await getLiveNote(vaultId, path))!.body.match(/exactly once/g)).toHaveLength(1)
    })

    it('a create that committed but never answered is replayed by its key', async () => {
      const path = 'docs/result-crash-create'
      setFailpointHandler((point) => {
        if (point === 'create.after-commit-before-file') throw new FailpointError(point)
      })
      const args = { vaultId, path, body: BODY, idempotency_key: 'crash-create-1' }
      expect((await call('create_note', args)).isError).toBe(true)
      setFailpointHandler(null)
      expect(await must<WriteResult>('create_note', args)).toMatchObject({ rev: 1, status: 'applied', replayed: true })
    })
  })

  it('keys older than 24 h are pruned, and a purged note takes its keys with it', async () => {
    const path = 'docs/result-prune'
    await must('create_note', { vaultId, path, body: BODY })
    await must('append_note', { vaultId, path, text: 'kept for a day', idempotency_key: 'prune-1' })
    await sql`UPDATE write_idempotency SET created_at = now() - interval '25 hours' WHERE key = 'prune-1'`
    await must('append_note', { vaultId, path, text: 'another', idempotency_key: 'prune-2' })
    expect(await db.select().from(writeIdempotency).where(eq(writeIdempotency.key, 'prune-1'))).toHaveLength(0)

    const { id } = await must<{ id: string }>('delete_note', { vaultId, path })
    expect(await db.select().from(writeIdempotency).where(eq(writeIdempotency.key, 'prune-2'))).toHaveLength(1)
    await must('purge_note', { vaultId, noteId: id })
    expect(await db.select().from(writeIdempotency).where(eq(writeIdempotency.key, 'prune-2'))).toHaveLength(0)
  })
})
