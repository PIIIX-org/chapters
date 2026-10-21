import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { db } from '../src/db/client.js'
import { FailpointError, setFailpointHandler } from '../src/failpoints.js'
import { parseNote, serializeNote } from '../src/notes/okf.js'
import { exportLegacyFiles } from '../src/notes/store-export.js'
import { loadCrdtState } from '../src/sync/crdt-store.js'
import { flushProjections } from '../src/notes/projector.js'
import { foldPendingCollab, getLiveNote, loadCollabState, purgeNote, softDeleteNote } from '../src/notes/store.js'
import { NoteNotMigratedError, collabNoteMigrated, setCollabNotMigrated } from '../src/notes/store-tx.js'
import { bootCollab, collabMigrated, runCollabBackfill } from '../src/sync/collab-backfill.js'
import { startCollabServer, type CollabRelay } from '../src/sync/collab-server.js'
import { createActiveUser, loginCookie, loginToken, storedCrdtDoc, storedCrdtText, wipeInstance } from './helpers.js'

// ADR-003 §8 step 4-5 and §9: the S2b backfill of `.crdt` bins into
// note_crdt (attach, set aside, resume, finish), the roll-forward after a
// code-only rollback, and the boot fold (§7 steps 4-5).

let app: FastifyInstance
let collab: CollabRelay
let port: number
let token: string
let cookie: string
let vaultId: string

beforeAll(async () => {
  // The finish needs every note of the instance done: start from an empty one.
  await wipeInstance()
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  port = typeof address === 'object' && address ? address.port : 0
  collab = startCollabServer(app.server)
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  token = await loginToken(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'S2b backfill vault' } })).json().id
})

afterEach(() => setFailpointHandler(null))

afterAll(async () => {
  setCollabNotMigrated([])
  await collab.destroy()
  await app.close()
})

async function create(name: string, body: string): Promise<{ id: string; path: string }> {
  const res = await app.inject({ method: 'POST', url: `/api/vaults/${vaultId}/notes`, headers: { cookie }, body: { type: 'docs', name, body } })
  expect(res.statusCode).toBe(200)
  return { id: res.json().id, path: `docs/${name}` }
}

const binFile = (path: string) => join(config.dataDir, 'vaults', vaultId, '.crdt', `${path}.bin`)

async function writeBin(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(binFile(path)), { recursive: true })
  await writeFile(binFile(path), bytes)
}

/** A bin the pre-S2b relay would have seeded from the note's text: its own random client, no shared history. */
function freshBin(text: string): Uint8Array {
  const doc = new Y.Doc()
  doc.getText('body').insert(0, text)
  doc.getMap('frontmatter').set('type', 'docs')
  return Y.encodeStateAsUpdate(doc)
}

const count = (s: string | undefined, needle: string) => (s ?? '').split(needle).length - 1

async function crdtRow(noteId: string): Promise<{ fold_error: string | null } | undefined> {
  const [row] = (await db.execute(sql`SELECT fold_error FROM note_crdt WHERE note_id = ${noteId}`)) as unknown as Array<{ fold_error: string | null }>
  return row
}

/** Typing the relay appended but never folded (a tab closed, then a kill): one update on the stored state, by a new client. */
async function appendTyping(noteId: string, path: string, text: string): Promise<void> {
  const { state } = await loadCollabState(vaultId, noteId)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  const before = Y.encodeStateVector(doc)
  const body = doc.getText('body')
  body.insert(body.length, text)
  await db.execute(sql`
    INSERT INTO note_updates (note_id, update, actor_type) VALUES (${noteId}, ${Buffer.from(Y.encodeStateAsUpdate(doc, before))}, 'user')`)
  expect(await storedCrdtText(vaultId, path)).toContain(text)
}

describe('the S2b backfill (§8 step 4)', () => {
  it('resumes after a note failed (the relay refuses it meanwhile, nothing seeds it), then finishes: marker set, .crdt/ to .crdt.pre-adr-003/', async () => {
    const vaultDir = join(config.dataDir, 'vaults', vaultId)
    const note = await create('fails-once', 'Old text.\n')
    // A bin the backfill cannot read (here a directory where the file should be).
    await mkdir(binFile(note.path), { recursive: true })
    const failed = await runCollabBackfill()
    expect(failed.failed.map((f) => f.noteId)).toEqual([note.id])
    expect(await collabMigrated()).toBe(false)
    expect((await stat(join(vaultDir, '.crdt'))).isDirectory()).toBe(true)
    expect(collabNoteMigrated(note.id)).toBe(false)

    // No editor and no seed until the restart: a seed would make the rerun skip the bin.
    await expect(loadCollabState(vaultId, note.id)).rejects.toBeInstanceOf(NoteNotMigratedError)
    let provider: HocuspocusProvider | undefined
    const reason = await new Promise<string>((resolve) => {
      provider = new HocuspocusProvider({
        url: `ws://127.0.0.1:${port}/collab`,
        name: `${vaultId}/~${note.id}`,
        token,
        document: new Y.Doc(),
        onAuthenticationFailed: (data) => resolve(data.reason),
      })
    })
    provider?.destroy()
    expect(reason).toBe('note-not-migrated')
    expect(await crdtRow(note.id)).toBeUndefined()

    // The cause fixed, the next start attaches the bin and finishes.
    await rm(binFile(note.path), { recursive: true })
    await writeBin(note.path, freshBin('Old text.\n'))
    const rerun = await runCollabBackfill()
    expect(rerun.failed).toEqual([])
    expect(rerun.attached.equal + rerun.attached.diffed).toBe(1)
    expect(collabNoteMigrated(note.id)).toBe(true)
    expect(await storedCrdtText(vaultId, note.path)).toBe('Old text.\n')
    expect(await collabMigrated()).toBe(true)
    await expect(stat(join(vaultDir, '.crdt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await stat(join(vaultDir, '.crdt.pre-adr-003', `${note.path}.bin`))).isFile()).toBe(true)
    expect(rerun.renamed).toEqual([join(vaultDir, '.crdt.pre-adr-003')])
  })

  it('attaches a bin whose text is the file, not the row or any revision (matches-file), with the row on top', async () => {
    const note = await create('file-text', 'Row text.\n')
    await flushProjections()
    // The file a crash left behind the row: the pre-S2b relay saved the bin from it.
    await writeFile(join(config.dataDir, 'vaults', vaultId, `${note.path}.md`), serializeNote({ frontmatter: { type: 'docs' }, body: 'File text.\n' }))
    await writeBin(note.path, freshBin('File text.\n'))
    const report = await runCollabBackfill()
    expect(report.failed).toEqual([])
    expect(report.setAside.map((s) => s.noteId)).not.toContain(note.id)
    expect(report.attached.diffed).toBeGreaterThanOrEqual(1)
    expect(await storedCrdtText(vaultId, note.path)).toBe('Row text.\n')
  })

  it('sets aside an undecodable bin', async () => {
    const note = await create('garbage-bin', 'Kept.\n')
    await writeBin(note.path, new Uint8Array([0xff, 0xfe, 0x01, 0x02, 0x03]))
    const report = await runCollabBackfill()
    const aside = report.setAside.find((s) => s.noteId === note.id)
    expect(aside?.reason).toBe('undecodable')
    expect((await stat(aside!.movedTo)).isFile()).toBe(true)
    expect(await storedCrdtText(vaultId, note.path)).toBe('')
  })
})

describe('roll-forward after a code-only rollback (§9)', () => {
  it('merges a bin the old relay saved from the exported state, once', async () => {
    expect(await collabMigrated()).toBe(true)
    const note = await create('rolled-back', 'Hello world.\n')
    const { state } = await loadCollabState(vaultId, note.id)
    // The old relay loaded the exported bin, a tab typed, the old store wrote row and bin.
    const old = new Y.Doc()
    Y.applyUpdate(old, state)
    old.getText('body').insert(old.getText('body').length, 'Typed while rolled back.\n')
    await writeBin(note.path, Y.encodeStateAsUpdate(old))
    await db.execute(sql`UPDATE notes SET body = ${'Hello world.\nTyped while rolled back.\n'} WHERE id = ${note.id}`)

    const { backfill } = await bootCollab()
    expect(backfill?.kind).toBe('adr-003-collab-roll-forward')
    expect(backfill?.merged).toBe(1)
    expect(backfill?.setAside.map((s) => s.noteId)).not.toContain(note.id)
    const text = await storedCrdtText(vaultId, note.path)
    expect(text).toBe('Hello world.\nTyped while rolled back.\n')
    expect((await getLiveNote(vaultId, note.path))?.body).toBe(text)
    expect(backfill?.renamed.some((r) => r.includes('.crdt.rollback-'))).toBe(true)
  })

  it('sets aside a bin with no history in common (old code seeded it from the file) instead of doubling the note', async () => {
    const note = await create('reseeded', 'Hello world.\n')
    await loadCollabState(vaultId, note.id)
    // No .crdt/ for the old relay (it was retired): it seeded a fresh bin from the file, then a tab typed.
    const reseeded = freshBin('Hello world.\nmore\n')
    await writeBin(note.path, reseeded)
    await db.execute(sql`UPDATE notes SET body = ${'Hello world.\nmore\n'} WHERE id = ${note.id}`)

    const { backfill } = await bootCollab()
    expect(backfill?.merged).toBe(0)
    const aside = backfill?.setAside.find((s) => s.noteId === note.id)
    expect(aside?.reason).toBe('unrelated')
    expect(Buffer.from(await readFile(aside!.movedTo))).toEqual(Buffer.from(reseeded))
    // The old code's change reaches the CRDT state through the rebase, once.
    const text = await storedCrdtText(vaultId, note.path)
    expect(text).toBe('Hello world.\nmore\n')
    expect(count(text, 'Hello world.')).toBe(1)
    expect((await getLiveNote(vaultId, note.path))?.body).toBe(text)
    expect((await crdtRow(note.id))?.fold_error).toBeNull()
  })

  it('store-export-legacy writes each note its bin, which the old relay takes as is, and the roll-forward merges what it wrote from it', async () => {
    // The export refuses to run before the S2a backfill finished; this file started from an empty instance.
    await db.execute(sql`
      INSERT INTO instance_state (id, store_migrated_at) VALUES ('singleton', now()) ON CONFLICT (id) DO UPDATE SET store_migrated_at = now()`)
    const note = await create('exported', 'Exported.\n')
    await appendTyping(note.id, note.path, 'Acked, not folded.\n')
    // The tail is still unfolded: the row lacks the typing until the export folds it.
    expect((await getLiveNote(vaultId, note.path))!.body).toBe('Exported.\n')
    const stored = await storedCrdtDoc(vaultId, note.path)

    const report = await exportLegacyFiles()
    expect(report.ok).toBe(true)
    expect(await loadCrdtState(vaultId, note.path)).not.toBeNull()
    expect(report.bins.failed).toEqual([])
    expect(report.bins.skipped.map((s) => s.noteId)).not.toContain(note.id)
    const row = (await getLiveNote(vaultId, note.path))!.body
    expect(row).toBe('Exported.\nAcked, not folded.\n')
    // The old relay's load: bin text = file text, so it keeps the bin's items and rebuilds nothing.
    const bin = new Y.Doc()
    Y.applyUpdate(bin, (await loadCrdtState(vaultId, note.path))!)
    const file = parseNote(await readFile(join(config.dataDir, 'vaults', vaultId, `${note.path}.md`), 'utf8'))
    expect(bin.getText('body').toString()).toBe(row)
    expect(file.body).toBe(row)
    // Same items as the stored state: a tab holding them merges, nothing doubles.
    expect(Y.encodeStateAsUpdate(stored, Y.encodeStateVector(bin)).byteLength).toBeLessThanOrEqual(2)

    // While rolled back, the old relay stores a tab's typing into the bin and the row.
    bin.getText('body').insert(bin.getText('body').length, 'Typed on the old image.\n')
    await writeBin(note.path, Y.encodeStateAsUpdate(bin))
    await db.execute(sql`UPDATE notes SET body = ${'Exported.\nAcked, not folded.\nTyped on the old image.\n'} WHERE id = ${note.id}`)
    const { backfill } = await bootCollab()
    expect(backfill?.kind).toBe('adr-003-collab-roll-forward')
    expect(backfill?.setAside.map((s) => s.noteId)).not.toContain(note.id)
    expect(backfill?.merged).toBeGreaterThanOrEqual(1)
    const text = await storedCrdtText(vaultId, note.path)
    expect(text).toBe('Exported.\nAcked, not folded.\nTyped on the old image.\n')
    expect((await getLiveNote(vaultId, note.path))?.body).toBe(text)
  })

  it('a note whose tail cannot be folded gets no bin (its typing stays in the log) and the export says it is incomplete', async () => {
    await db.execute(sql`
      INSERT INTO instance_state (id, store_migrated_at) VALUES ('singleton', now()) ON CONFLICT (id) DO UPDATE SET store_migrated_at = now()`)
    const note = await create('export-unfolded', 'Base.\n')
    await appendTyping(note.id, note.path, 'Unfolded.\n')
    setFailpointHandler((point) => {
      if (point === 'fold.before-commit') throw new FailpointError(point)
    })
    const report = await exportLegacyFiles()
    setFailpointHandler(null)
    expect(report.ok).toBe(false)
    expect(report.folded.failed).toBeGreaterThanOrEqual(1)
    expect(report.bins.skipped.map((s) => s.noteId)).toContain(note.id)
    expect(await loadCrdtState(vaultId, note.path)).toBeNull()
    expect(await storedCrdtText(vaultId, note.path)).toBe('Base.\nUnfolded.\n')
    // Leave no export bins for the tests after this one.
    await rm(join(config.dataDir, 'vaults', vaultId, '.crdt'), { recursive: true, force: true })
  })
})

describe('the boot fold (§7 steps 4-5)', () => {
  it('folds a pending tail into the row', async () => {
    const note = await create('pending-tail', 'Base.\n')
    await appendTyping(note.id, note.path, 'Unfolded.\n')
    const { failed } = await foldPendingCollab()
    expect(failed).toBe(0)
    expect((await getLiveNote(vaultId, note.path))?.body).toBe('Base.\nUnfolded.\n')
  })

  it('sets fold_error when a note fails, and goes on', async () => {
    const note = await create('fold-fails', 'Base.\n')
    await appendTyping(note.id, note.path, 'Unfolded.\n')
    setFailpointHandler((point) => {
      if (point === 'fold.before-commit') throw new FailpointError(point)
    })
    const { failed } = await foldPendingCollab()
    expect(failed).toBeGreaterThanOrEqual(1)
    expect((await crdtRow(note.id))?.fold_error).toMatch(/^boot fold failed: failpoint fold\.before-commit/)
    expect((await getLiveNote(vaultId, note.path))?.body).toBe('Base.\n')
    setFailpointHandler(null)
    await foldPendingCollab()
    expect((await crdtRow(note.id))?.fold_error).toBeNull()
    expect((await getLiveNote(vaultId, note.path))?.body).toBe('Base.\nUnfolded.\n')
  })

  it('keeps fold_error naming a stored update that does not apply, after the fold that rejected it', async () => {
    const note = await create('bad-update', 'Base.\n')
    await loadCollabState(vaultId, note.id)
    await db.execute(sql`
      INSERT INTO note_updates (note_id, update, actor_type) VALUES (${note.id}, ${Buffer.from([0xff, 0xff, 0xff, 0x7f])}, 'user')`)
    const { failed } = await foldPendingCollab()
    expect(failed).toBe(0)
    const [update] = (await db.execute(sql`
      SELECT rejected_at IS NOT NULL AS rejected FROM note_updates WHERE note_id = ${note.id} ORDER BY id DESC LIMIT 1`)) as unknown as Array<{ rejected: boolean }>
    expect(update?.rejected).toBe(true)
    expect((await crdtRow(note.id))?.fold_error).toMatch(/^update \d+ rejected: /)
    expect(await storedCrdtText(vaultId, note.path)).toBe('Base.\n')
  })
})

describe('purge', () => {
  it('deletes the note CRDT state and update log with the note (cascade)', async () => {
    const note = await create('purged', 'Gone soon.\n')
    await appendTyping(note.id, note.path, 'Typed.\n')
    await softDeleteNote(vaultId, note.path)
    expect(await purgeNote(vaultId, note.id)).toBe(true)
    const [left] = (await db.execute(sql`
      SELECT (SELECT count(*)::int FROM note_crdt WHERE note_id = ${note.id}) AS crdt,
             (SELECT count(*)::int FROM note_updates WHERE note_id = ${note.id}) AS updates`)) as unknown as Array<{ crdt: number; updates: number }>
    expect(left).toEqual({ crdt: 0, updates: 0 })
  })
})
