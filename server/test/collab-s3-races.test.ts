import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { appendCollabUpdate, foldPendingCollab, getLiveNote, writeNote } from '../src/notes/store.js'
import { StoreBusyError, lockedNote, storeTransaction } from '../src/notes/store-tx.js'
import { appendGate, compactNoteCrdt, markFolded, readNoteCrdt } from '../src/sync/note-crdt.js'
import { withKeyLock } from '../src/notes/key-lock.js'
import { startCollabServer, type CollabRelay } from '../src/sync/collab-server.js'
import { createActiveUser, loginCookie, loginToken } from './helpers.js'

// ADR-003 S3: a collab append never waits for a fold or a write holding the
// note's lock. A fold stops at the boundary of its tail read, so an append
// that lands while it runs is neither marked folded nor compacted away; a
// write computes against exactly the state it read and leaves later typing
// to merge; a crash in the middle of a fold leaves the appended rows for boot.

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

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  port = typeof address === 'object' && address ? address.port : 0
  collab = startCollabServer(app.server)
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  token = await loginToken(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'S3 races vault' } })).json().id
})

afterAll(async () => {
  providers.forEach((p) => p.destroy())
  await collab.destroy()
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

/** A note with CRDT state and no editor: opened once (the load seeds it), then closed and unloaded. */
async function seeded(name: string, body: string) {
  const note = await create(name, body)
  const { provider } = await open(note.id)
  provider.destroy()
  await waitFor(() => !collab.hocuspocus.documents.has(`${vaultId}/~${note.id}`))
  return note
}

/** An update that appends `marker` to the note's body as Postgres holds it now, as an editor would send it. */
async function typingUpdate(noteId: string, marker: string): Promise<Uint8Array> {
  const doc = await storeTransaction([noteId], async (tx) => (await readNoteCrdt(tx, noteId))!.doc)
  const before = Y.encodeStateVector(doc)
  doc.getText('body').insert(doc.getText('body').length, marker)
  return Y.encodeStateAsUpdate(doc, before)
}

const rowBody = async (path: string) => (await getLiveNote(vaultId, path))?.body

async function logRow(id: number) {
  const [row] = (await db.execute(sql`
    SELECT u.id, c.folded_through, c.snapshot_through FROM note_updates u JOIN note_crdt c ON c.note_id = u.note_id
    WHERE u.id = ${id}`)) as unknown as Array<{ id: string; folded_through: string; snapshot_through: string }>
  return row
}

describe('appends during a fold (S3)', () => {
  it('an append that lands while a fold runs is not marked folded, and compaction keeps it', async () => {
    const note = await seeded('during-fold', 'Seeded.\n')
    const update = await typingUpdate(note.id, '@DURING-FOLD@')
    let appended: number | null = null
    await storeTransaction([note.id], async (tx) => {
      const locked = (await lockedNote(tx, note.id))!
      const crdt = (await readNoteCrdt(tx, note.id))!
      // The fold holds the note's locks; the append does not wait for them.
      appended = (await appendCollabUpdate(vaultId, note.id, update, { type: 'collab', id: randomUUID() }))?.id ?? null
      await markFolded(tx, crdt, locked.seq)
      await compactNoteCrdt(tx, crdt)
    })
    expect(appended).not.toBeNull()
    const row = await logRow(appended!)
    expect(row).toBeDefined()
    expect(Number(row!.folded_through)).toBeLessThan(appended!)
    expect(Number(row!.snapshot_through)).toBeLessThan(appended!)
    // The next fold (here boot's) takes it.
    await foldPendingCollab()
    expect(count(await rowBody(note.path), '@DURING-FOLD@')).toBe(1)
  }, 30_000)

  it('a crash in the middle of a fold leaves the rows appended meanwhile for boot', async () => {
    const note = await seeded('crash-mid-fold', 'Seeded.\n')
    const update = await typingUpdate(note.id, '@CRASH-MID-FOLD@')
    await expect(
      storeTransaction([note.id], async (tx) => {
        const locked = (await lockedNote(tx, note.id))!
        const crdt = (await readNoteCrdt(tx, note.id))!
        await appendCollabUpdate(vaultId, note.id, update, { type: 'collab', id: randomUUID() })
        await markFolded(tx, crdt, locked.seq)
        await compactNoteCrdt(tx, crdt)
        throw new Error('crash before the fold commits')
      }),
    ).rejects.toThrow('crash before the fold commits')
    expect(count(await rowBody(note.path), '@CRASH-MID-FOLD@')).toBe(0)
    await foldPendingCollab()
    expect(count(await rowBody(note.path), '@CRASH-MID-FOLD@')).toBe(1)
  }, 30_000)
})

describe('typing during an agent write (S3, §5.2)', () => {
  it('is acked while the write holds the note lock, and neither the write nor the typing is lost', async () => {
    const note = await create('typing-during-write', 'Start.\n')
    const { provider, text } = await open(note.id)
    // Acked before the write starts: the write must see it.
    text.insert(text.length, '@BEFORE-WRITE@\n')
    await waitFor(() => !provider.hasUnsyncedChanges)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let computing!: () => void
    const inCompute = new Promise<void>((r) => (computing = r))
    let sawBefore = false
    const write = writeNote(
      vaultId,
      note.path,
      async (current) => {
        sawBefore = current.body.includes('@BEFORE-WRITE@')
        computing()
        await gate
        return { frontmatter: { ...current.frontmatter, type: 'docs' }, body: `${current.body}Agent line.\n` }
      },
      { type: 'mcp', id: randomUUID() },
    )
    await inCompute
    // The write holds the note's lock; this typing is still logged and acked at once.
    text.insert(0, '@DURING-WRITE@ ')
    await waitFor(() => !provider.hasUnsyncedChanges, 3000)
    release()
    await write
    expect(sawBefore).toBe(true)
    await waitFor(() => text.toString().includes('Agent line.'))
    for (const marker of ['@BEFORE-WRITE@', '@DURING-WRITE@', 'Agent line.']) expect(count(text.toString(), marker)).toBe(1)
    await waitFor(async () => {
      const body = await rowBody(note.path)
      return ['@BEFORE-WRITE@', '@DURING-WRITE@', 'Agent line.'].every((m) => count(body, m) === 1)
    })
  }, 30_000)
})

describe('backpressure (S3)', () => {
  it('refuses an append past the per-note bound as busy (retryable), and takes the rest once the queue drains', async () => {
    const note = await seeded('backpressure', 'Seeded.\n')
    const update = await typingUpdate(note.id, '@QUEUED@')
    let release!: () => void
    const held = withKeyLock(appendGate(note.id), () => new Promise<void>((r) => (release = r)))
    const queued = Array.from({ length: 256 }, () => appendCollabUpdate(vaultId, note.id, update, { type: 'collab' }))
    await expect(appendCollabUpdate(vaultId, note.id, update, { type: 'collab' })).rejects.toBeInstanceOf(StoreBusyError)
    release()
    await held
    // 256 short transactions drain one after another through the gate.
    expect((await Promise.all(queued)).every((logged) => logged !== null)).toBe(true)
  }, 120_000)
})
