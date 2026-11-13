import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type * as LastRead from '../src/mcp/last-read.js'
import type * as NoteStore from '../src/notes/store.js'
import { setTimeout as sleep } from 'node:timers/promises'
import postgres from 'postgres'
import { and, eq } from 'drizzle-orm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { buildApp } from '../src/app.js'
import { db, sql } from '../src/db/client.js'
import { noteReads, writeIdempotency } from '../src/db/schema.js'
import { advanceRead, confirmRead, rememberRead } from '../src/mcp/last-read.js'
import { runWrite, writeAnswer } from '../src/mcp/write-result.js'
import { createNote, getBaseRevision, getLiveNote, purgeRevision, readLiveNote, updateNote } from '../src/notes/store.js'
import { writeThroughCollab } from '../src/sync/crdt-write.js'
import { startCollabServer, type CollabRelay } from '../src/sync/collab-server.js'
import { purgeVaultRecord, trashVaultRecord } from '../src/vaults/routes.js'
import { createActiveUser, loginCookie, loginToken } from './helpers.js'

// Pause only timing boundaries. Both wrappers delegate to the real store/retention implementation.
const pause = vi.hoisted(() => ({ advance: null as null | (() => Promise<void>), create: null as null | (() => Promise<void>), createPath: '' }))
vi.mock('../src/mcp/last-read.js', async (importOriginal) => {
  const actual = await importOriginal<typeof LastRead>()
  return { ...actual, advanceRead: async (...args: Parameters<typeof actual.advanceRead>) => {
    await pause.advance?.()
    return actual.advanceRead(...args)
  } }
})
vi.mock('../src/notes/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof NoteStore>()
  return { ...actual, createNote: async (...args: Parameters<typeof actual.createNote>) => {
    if (args[1].path === pause.createPath) await pause.create?.()
    return actual.createNote(...args)
  } }
})

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 4000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('security boundary was not reached')
    await sleep(10)
  }
}
async function waitingForDatabaseMutex(n = 1) {
  await until(async () => {
    const [row] = await sql`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`
    return Number(row!.n) >= n
  })
}

let app: FastifyInstance
let relay: CollabRelay
let baseUrl: string
let cookie: string
let session: string
let connectionId: string
let mcp: Client
const providers: HocuspocusProvider[] = []

async function vault() {
  return (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'purge security' } })).json<{ id: string }>().id
}
async function must<T extends Record<string, unknown>>(name: string, args: Record<string, unknown>): Promise<T> {
  const answer = await mcp.callTool({ name, arguments: args })
  expect(answer.isError, JSON.stringify(answer)).not.toBe(true)
  expect(answer.structuredContent).toBeDefined()
  return answer.structuredContent as T
}
async function human(vaultId: string, noteId: string) {
  const provider = new HocuspocusProvider({ url: baseUrl.replace('http', 'ws') + '/collab', name: `${vaultId}/~${noteId}`, token: session, document: new Y.Doc() })
  providers.push(provider)
  await until(() => provider.isSynced && provider.document.getText('body').length > 0)
  return provider
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  relay = startCollabServer(app.server)
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  session = await loginToken(app, owner.email)
  const minted = (await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: 'purge security writer', scope: 'account', access: 'admin', profile: 'admin' } })).json<{ id: string; token: string }>()
  connectionId = minted.id
  mcp = new Client({ name: 'purge-security', version: '1' })
  await mcp.connect(new StreamableHTTPClientTransport(new URL(baseUrl + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${minted.token}` } } }))
})
afterEach(() => { pause.advance = null; pause.create = null; pause.createPath = '' })
afterAll(async () => {
  providers.forEach((provider) => provider.destroy())
  await mcp?.close()
  await relay?.destroy()
  await app?.close()
})

it('rejects delayed merged-write plaintext after revision purge without moving seq, preserves ACKed typing and replays only a content-free key', async () => {
  const id = await vault()
  const path = 'docs/merged-retention'
  const body = 'Legacy secret payload.\nStable middle.\nLast line.\n'
  const note = await createNote(id, { path, body })
  const base = await getBaseRevision(id, path, note.seq)
  const observed = await must('read_note', { vaultId: id, path })
  expect(observed).not.toHaveProperty('purgeEpoch')
  const tab = await human(id, note.id)
  const text = tab.document.getText('body')
  text.delete(0, 'Legacy secret payload.\n'.length)
  text.insert(0, 'Human clean line.\n')
  await until(() => !tab.hasUnsyncedChanges)
  const reached = gate()
  const resume = gate()
  pause.advance = async () => { reached.release(); await resume.promise }
  const args = { vaultId: id, path, body: 'Legacy secret payload.\nStable middle.\nAgent final line.\n', idempotency_key: 'merged-retention-key' }
  const writing = must('edit_note', args)
  try {
    await Promise.race([reached.promise, writing.then(() => { throw new Error('write did not pause before retained-body upsert') })])
    const committed = await readLiveNote(id, path)
    expect(committed!.body).toBe('Human clean line.\nStable middle.\nAgent final line.\n')
    expect(await purgeRevision(id, base!.id)).toBe(true)
    const after = await readLiveNote(id, path)
    expect(after!.row.seq).toBe(committed!.row.seq)
    expect(after!.row.purgeEpoch).toBe(committed!.row.purgeEpoch + 1)
    resume.release()
    const answer = await writing
    expect(answer).toMatchObject({ status: 'conflicted', purged: true })
    expect(JSON.stringify(answer)).not.toContain('Legacy secret')
    expect(await db.select().from(noteReads).where(eq(noteReads.noteId, note.id))).toHaveLength(0)
    const retry = await must('edit_note', args)
    expect(retry).toMatchObject({ status: 'conflicted', purged: true, replayed: true })
    const reconnected = await human(id, note.id)
    expect(reconnected.document.getText('body').toString()).toBe('Human clean line.\nStable middle.\nAgent final line.\n')
  } finally { resume.release(); await writing.catch(() => undefined) }
}, 30_000)

it('serializes remember/confirm/advance with a second database client and rejects a stale epoch even while the exact current revision survives', async () => {
  const id = await vault()
  const note = await createNote(id, { path: 'docs/database-mutex', body: 'Old revision.\n' })
  const old = await getBaseRevision(id, note.path, note.seq)
  await updateNote(id, note.path, { body: 'Current clean revision.\n' })
  const current = (await readLiveNote(id, note.path))!.row
  await rememberRead(connectionId, note.id, current.seq, current.purgeEpoch, 'Prior merged caller payload.')
  const other = postgres(process.env.DATABASE_URL!, { max: 1 })
  const locked = gate()
  const release = gate()
  const holder = other.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock_shared(hashtextextended(${`vault-retention:${id}`}, 0))`
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${note.id}::text, 0))`
    locked.release()
    await release.promise
    await tx`UPDATE notes SET purge_epoch = purge_epoch + 1 WHERE id = ${note.id}`
    await tx`DELETE FROM note_reads WHERE note_id = ${note.id}`
    await tx`DELETE FROM note_revisions WHERE id = ${old!.id}`
  })
  await locked.promise
  const retaining = Promise.all([
    rememberRead(connectionId, note.id, current.seq, current.purgeEpoch, 'Stale plaintext must not return.'),
    confirmRead(connectionId, note.id, current.seq, current.purgeEpoch),
    advanceRead(connectionId, note.id, current.seq, current.purgeEpoch, 'Stale advanced plaintext.'),
  ])
  try {
    await waitingForDatabaseMutex(3)
    release.release()
    await holder
    await retaining
    expect((await readLiveNote(id, note.path))!.row.seq).toBe(current.seq)
    expect(await db.select().from(noteReads).where(eq(noteReads.noteId, note.id))).toHaveLength(0)
  } finally { release.release(); await holder; await retaining; await other.end() }
}, 30_000)

it('refuses a real MCP keyed create admitted before trash/purge but delayed after authorization', async () => {
  const id = await vault()
  const reached = gate()
  const resume = gate()
  pause.createPath = 'docs/late-authorized-create'
  pause.create = async () => { reached.release(); await resume.promise }
  const writing = mcp.callTool({ name: 'create_note', arguments: { vaultId: id, path: pause.createPath, body: 'Late secret payload.', idempotency_key: 'late-authorized-create' } })
  try {
    await Promise.race([reached.promise, writing.then(() => { throw new Error('create did not pause after authorization') })])
    await trashVaultRecord(id)
    await purgeVaultRecord(id)
    resume.release()
    expect((await writing).isError).toBe(true)
    expect(await db.select().from(writeIdempotency).where(and(eq(writeIdempotency.connectionId, connectionId), eq(writeIdempotency.key, 'late-authorized-create')))).toHaveLength(0)
    const retry = await mcp.callTool({ name: 'create_note', arguments: { vaultId: id, path: pause.createPath, body: 'Late secret payload.', idempotency_key: 'late-authorized-create' } })
    expect(retry.isError).toBe(true)
  } finally { resume.release(); await writing.catch(() => undefined) }
}, 30_000)

describe.each(['create', 'edit'] as const)('vault purge with an admitted %s transaction', (mode) => {
  it('waits for the shared vault fence, scrubs after COMMIT and preserves non-resurrecting effect tombstones through post-write completion', async () => {
    const id = await vault()
    const path = 'docs/admitted-' + mode
    if (mode === 'edit') await createNote(id, { path, body: 'Before the admitted write.\n' })
    const reached = gate()
    const resume = gate()
    const key = 'admitted-' + mode
    const args = { path, body: 'Secret retained inside the admitted write.\n' }
    const call = { connectionId, target: id, tool: mode === 'create' ? 'create_note' : 'edit_note', args, key }
    const writing = runWrite(call, async (keyed) => {
      const receipt = keyed((row) => writeAnswer(row, { status: 'applied', before: null }, false))!
      const recordKey: NoteStore.RecordKey = async (tx, row) => { await receipt(tx, row); reached.release(); await resume.promise }
      const row = mode === 'create'
        ? await createNote(id, args, { type: 'mcp', id: connectionId }, { recordKey })
        : await writeThroughCollab(id, path, { body: args.body }, { type: 'mcp', id: connectionId }, { recordKey })
      return writeAnswer(row!, { status: 'applied', before: null }, false)
    })
    await reached.promise
    await trashVaultRecord(id)
    const purging = purgeVaultRecord(id)
    try {
      await waitingForDatabaseMutex()
      resume.release()
      await Promise.all([writing, purging])
      const [receipt] = await db.select().from(writeIdempotency).where(and(eq(writeIdempotency.connectionId, connectionId), eq(writeIdempotency.key, key)))
      expect(receipt!.noteId).toBeNull()
      expect(receipt!.result).toMatchObject({ status: 'conflicted', purged: true })
      expect(JSON.stringify(receipt!.result)).not.toContain('Secret retained')
      expect((await writing)).toMatchObject({ status: 'conflicted', purged: true })
      const replay = await runWrite(call, async () => { throw new Error('a purged effect must not run again') })
      expect(replay).toMatchObject({ purged: true, replayed: true })
      expect(await getLiveNote(id, path)).toBeNull()
    } finally { resume.release(); await Promise.allSettled([writing, purging]) }
  }, 30_000)
})

it('turns a real delayed post-write fallback into a content-free effect when its vault vanished before key retention', async () => {
  const id = await vault()
  const path = 'docs/post-write-fallback'
  const reached = gate()
  const resume = gate()
  const call = { connectionId, target: id, tool: 'create_note', args: { path, body: 'Fallback secret payload.' }, key: 'post-write-fallback' }
  const writing = runWrite(call, async () => {
    const row = await createNote(id, call.args)
    reached.release()
    await resume.promise
    return writeAnswer(row, { status: 'applied', before: null }, false)
  })
  try {
    await reached.promise
    await trashVaultRecord(id)
    await purgeVaultRecord(id)
    resume.release()
    expect(await writing).toMatchObject({ status: 'conflicted', purged: true })
    const replay = await runWrite(call, async () => { throw new Error('post-write fallback must not recreate its effect') })
    expect(replay).toMatchObject({ purged: true, replayed: true })
    expect(JSON.stringify(replay)).not.toContain('Fallback secret')
  } finally { resume.release(); await writing.catch(() => undefined) }
}, 30_000)
