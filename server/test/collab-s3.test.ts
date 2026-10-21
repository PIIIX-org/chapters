import { readFile } from 'node:fs/promises'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { db, sql as pg } from '../src/db/client.js'
import { FailpointError, setFailpointHandler, type Failpoint } from '../src/failpoints.js'
import { foldPendingCollab, getLiveNote, noteFile, readLiveNote } from '../src/notes/store.js'
import { INSTANCE_LOCK_KEY } from '../src/notes/maintenance-lock.js'
import { startCollabServer, type CollabRelay } from '../src/sync/collab-server.js'
import { createActiveUser, loginCookie, loginToken } from './helpers.js'

// ADR-003 S3 (#487): a collab update is committed to note_updates before the
// relay applies and acknowledges it, so what the editor shows as saved
// survives a SIGKILL at any point after the ack; the last tab closing folds
// at once instead of waiting out the debounce. The relay's real 2 s debounce
// is used here (the suite default is 150 ms), so "before the store" is a
// window the tests can stand in.
vi.hoisted(() => {
  process.env.COLLAB_DEBOUNCE_MS = '2000'
})

let app: FastifyInstance
let collab: CollabRelay
let port: number
let token: string
let cookie: string
let vaultId: string
const providers: HocuspocusProvider[] = []

async function waitFor(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

const count = (s: string | undefined, needle: string) => (s ?? '').split(needle).length - 1

/** Simulates a crash at `point`, once: the code after it does not run. */
function crashOnceAt(point: Failpoint): void {
  let fired = false
  setFailpointHandler((name: Failpoint) => {
    if (name !== point || fired) return
    fired = true
    throw new FailpointError(name)
  })
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  port = typeof address === 'object' && address ? address.port : 0
  collab = startCollabServer(app.server)
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  token = await loginToken(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'S3 ack vault' } })).json().id
})

afterEach(() => setFailpointHandler(null))

afterAll(async () => {
  providers.forEach((p) => p.destroy())
  await collab.destroy().catch(() => undefined)
  await app.close()
})

async function create(name: string, body: string): Promise<{ id: string; path: string }> {
  const res = await app.inject({ method: 'POST', url: `/api/vaults/${vaultId}/notes`, headers: { cookie }, body: { type: 'docs', name, body } })
  expect(res.statusCode).toBe(200)
  return { id: res.json().id, path: `docs/${name}` }
}

async function open(noteId: string) {
  const provider = new HocuspocusProvider({ url: `ws://127.0.0.1:${port}/collab`, name: `${vaultId}/~${noteId}`, token, document: new Y.Doc() })
  providers.push(provider)
  const text = provider.document.getText('body')
  await waitFor(() => provider.isSynced && text.length > 0)
  return { provider, text }
}

/** Types `marker` at the end and waits for the relay's ack (SyncStatus true: the editor shows it as saved). */
async function typeAcked(provider: HocuspocusProvider, text: Y.Text, marker: string): Promise<void> {
  text.insert(text.length, `\n${marker}`)
  expect(provider.hasUnsyncedChanges).toBe(true)
  await waitFor(() => !provider.hasUnsyncedChanges)
}

const rowBody = async (path: string) => (await getLiveNote(vaultId, path))?.body

/** The note's text as Postgres holds it right now (snapshot ⊕ non-rejected tail): what a SIGKILL at this instant leaves. */
async function storedText(noteId: string): Promise<string> {
  const [state] = (await db.execute(sql`SELECT snapshot, snapshot_through FROM note_crdt WHERE note_id = ${noteId}`)) as unknown as Array<{
    snapshot: Uint8Array
    snapshot_through: string
  }>
  const doc = new Y.Doc()
  Y.applyUpdate(doc, new Uint8Array(state!.snapshot))
  const tail = (await db.execute(sql`
    SELECT update FROM note_updates WHERE note_id = ${noteId} AND id > ${state!.snapshot_through} AND rejected_at IS NULL ORDER BY id`)) as unknown as Array<{
    update: Uint8Array
  }>
  for (const { update } of tail) Y.applyUpdate(doc, new Uint8Array(update))
  return doc.getText('body').toString()
}

describe('an acknowledged collab edit is in Postgres at the ack (#487)', () => {
  it('survives a SIGKILL after the ack: the tab closed, the relay died before its store, boot folds it', async () => {
    const note = await create('killed-after-ack', 'Before the kill.\n')
    const { provider, text } = await open(note.id)
    const marker = '@S3-KILL-AFTER-ACK@'
    await typeAcked(provider, text, marker)
    // Inside the 2 s debounce, nothing has stored the document: the log alone holds the edit.
    expect(count(await storedText(note.id), marker)).toBe(1)
    // The tab closes and the process "dies" at the start of the fold the close triggers: nothing after that point runs.
    let foldsCut = 0
    setFailpointHandler((name) => {
      if (name !== 'collab.after-ack-before-fold') return
      foldsCut++
      throw new FailpointError(name)
    })
    provider.destroy()
    await waitFor(() => foldsCut > 0)
    expect(count(await rowBody(note.path), marker)).toBe(0)
    setFailpointHandler(null)
    // The dead process's memory is gone, and no hook of its runs: its unstored document goes with it.
    collab.hocuspocus.documents.delete(`${vaultId}/~${note.id}`)
    // Boot (§7 step 5) folds every pending tail into row + revision.
    await foldPendingCollab()
    expect(count(await rowBody(note.path), marker)).toBe(1)
    // The boot fold wakes the projector: the file follows the row at once, not at the projector's next poll.
    await waitFor(async () => count(await readFile(noteFile(vaultId, note.path), 'utf8').catch(() => ''), marker) === 1, 1500)
    const [revision] = (await db.execute(sql`
      SELECT body FROM note_revisions WHERE note_id = ${note.id} ORDER BY ord DESC LIMIT 1`)) as unknown as Array<{ body: string }>
    expect(count(revision!.body, marker)).toBe(1)
  }, 30_000)

  it('read_note folds the acked typing of a tab that closed before any store (§6)', async () => {
    const note = await create('read-after-kill', 'Before the kill.\n')
    const { provider, text } = await open(note.id)
    const marker = '@S3-READ-AFTER-KILL@'
    await typeAcked(provider, text, marker)
    let foldsCut = 0
    setFailpointHandler((name) => {
      if (name !== 'collab.after-ack-before-fold') return
      foldsCut++
      throw new FailpointError(name)
    })
    provider.destroy()
    await waitFor(() => foldsCut > 0)
    setFailpointHandler(null)
    collab.hocuspocus.documents.delete(`${vaultId}/~${note.id}`)
    expect(count(await rowBody(note.path), marker)).toBe(0)
    // No editor has the note open: the read still folds the log first, and serves (and stores) the typing.
    expect(count((await readLiveNote(vaultId, note.path))?.body, marker)).toBe(1)
    expect(count(await rowBody(note.path), marker)).toBe(1)
  }, 30_000)

  it('a crash after the log commit and before the ack: the client resends, the text lands once', async () => {
    const note = await create('killed-before-ack', 'Before the kill.\n')
    const { provider, text } = await open(note.id)
    const marker = '@S3-KILL-BEFORE-ACK@'
    crashOnceAt('collab.after-log-before-ack')
    text.insert(text.length, `\n${marker}`)
    // The connection closes unacked, reconnects and resends. The live document never took the first copy, so the resend
    // is logged as a second row with the same items; applying it twice is harmless and the text lands once.
    await waitFor(() => !provider.hasUnsyncedChanges, 15_000)
    expect(count(await storedText(note.id), marker)).toBe(1)
    expect(count(text.toString(), marker)).toBe(1)
    provider.destroy()
    await waitFor(async () => count(await rowBody(note.path), marker) === 1)
  }, 30_000)

  it('the last tab closing inside the 2 s window folds the edit into the row at once', async () => {
    const note = await create('closed-in-window', 'Before the close.\n')
    const { provider, text } = await open(note.id)
    const marker = '@S3-CLOSED-IN-WINDOW@'
    await typeAcked(provider, text, marker)
    provider.destroy()
    // Well inside the debounce: the close stored it, not the timer.
    await waitFor(async () => count(await rowBody(note.path), marker) === 1, 1000)
  }, 20_000)

  it('an update the log refuses is never acknowledged: the editor keeps it unsynced', async () => {
    const note = await create('refused-append', 'Live.\n')
    const { provider, text } = await open(note.id)
    // The note leaves the store behind the relay's back: an append to it is refused.
    await db.execute(sql`UPDATE notes SET deleted_at = now() WHERE id = ${note.id}`)
    let closed = false
    provider.on('close', () => {
      closed = true
    })
    text.insert(text.length, '\n@S3-REFUSED@')
    // The relay closes the socket without an ack.
    await waitFor(() => closed)
    expect(provider.hasUnsyncedChanges).toBe(true)
    expect(count(await storedText(note.id), '@S3-REFUSED@')).toBe(0)
    provider.destroy()
  }, 20_000)
})

describe('a busy store across a reconnect (S3)', () => {
  it('refuses the reload with store-busy, not a revocation, and the change lands once the store is back', async () => {
    const note = await create('busy-store', 'Before.\n')
    const document = new Y.Doc()
    const reasons: string[] = []
    // What useCollabDoc does on store-busy: a new provider on the same document after a pause.
    const connectTab = () => {
      const provider = new HocuspocusProvider({
        url: `ws://127.0.0.1:${port}/collab`,
        name: `${vaultId}/~${note.id}`,
        token,
        document,
        onAuthenticationFailed: ({ reason }) => reasons.push(reason),
        // A store-busy refusal closes the socket too (1013), so it can arrive as the close reason.
        onClose: ({ event }) => {
          if (event.reason) reasons.push(event.reason)
        },
      })
      providers.push(provider)
      return provider
    }
    let provider = connectTab()
    const text = document.getText('body')
    await waitFor(() => provider.isSynced && text.length > 0)
    const held = await pg.reserve()
    try {
      // Maintenance holds the instance lock: the append fails, the socket closes, the reload is refused.
      await held`SELECT pg_advisory_lock(${INSTANCE_LOCK_KEY.toString()}::bigint)`
      text.insert(text.length, '@BUSY-STORE@')
      await waitFor(() => reasons.length > 0, 15_000)
      expect(reasons[0]).toBe('store-busy')
      expect(reasons).not.toContain('permission-denied')
      expect(provider.hasUnsyncedChanges).toBe(true)
    } finally {
      await held`SELECT pg_advisory_unlock(${INSTANCE_LOCK_KEY.toString()}::bigint)`
      held.release()
    }
    provider.destroy()
    provider = connectTab()
    await waitFor(() => provider.isSynced && !provider.hasUnsyncedChanges, 15_000)
    expect(count(text.toString(), '@BUSY-STORE@')).toBe(1)
    expect(count(await storedText(note.id), '@BUSY-STORE@')).toBe(1)
  }, 40_000)
})
