import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import * as Y from 'yjs'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { db } from '../src/db/client.js'
import { FailpointError, setFailpointHandler, type Failpoint } from '../src/failpoints.js'
import { createNote, purgeNote, readNote, renameNote, restoreNote, revertNote, softDeleteNote, updateNote } from '../src/notes/store.js'
import { flushProjections } from '../src/notes/projector.js'
import { bootStore, reconcileStore, runStoreBackfill } from '../src/notes/store-reconcile.js'
import { serializeNote } from '../src/notes/okf.js'
import { checkNoteFiles } from '../src/notes/integrity.js'
import { writeThroughCollab } from '../src/sync/crdt-write.js'
import { crdtFile, saveCrdtState } from '../src/sync/crdt-store.js'
import { createActiveUser, loginCookie } from './helpers.js'

// ADR-003 S2a: Postgres is the only authority for server writes. Every write
// is one transaction (row + revision at the new seq + links + projection
// targets); files and index.md are projections written after commit.

let app: FastifyInstance
let vaultId: string

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  const owner = await createActiveUser()
  const cookie = await loginCookie(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'S2a vault' } })).json().id
})

afterEach(() => setFailpointHandler(null))
afterAll(async () => app.close())

const file = (...parts: string[]) => join(config.dataDir, 'vaults', vaultId, ...parts)
const agent = () => ({ type: 'mcp' as const, id: randomUUID() })

/** Throws at `name`, as a SIGKILL there would stop the call. */
function crashAt(name: Failpoint): void {
  setFailpointHandler((point) => {
    if (point === name) throw new FailpointError(point)
  })
}

async function state(noteId: string) {
  const [row] = (await db.execute(sql`SELECT seq, body, path, deleted_at FROM notes WHERE id = ${noteId}`)) as unknown as Array<{
    seq: string
    body: string
    path: string
    deleted_at: string | null
  }>
  const revisions = (await db.execute(sql`
    SELECT seq, action, actor_type, actor_id, body FROM note_revisions WHERE note_id = ${noteId} ORDER BY ord`)) as unknown as Array<{
    seq: string | null
    action: string
    actor_type: string
    actor_id: string | null
    body: string
  }>
  return { row, revisions }
}

/** I2: the revision at notes.seq exists and holds the row's body. */
async function expectRevisionAtSeq(noteId: string) {
  const { row, revisions } = await state(noteId)
  const atSeq = revisions.filter((r) => r.seq === row!.seq)
  expect(atSeq).toHaveLength(1)
  expect(atSeq[0]!.body).toBe(row!.body)
}

describe('one transaction per write (Invariant W)', () => {
  it('records a revision at every seq, for create, edit, rename, delete, restore and revert (I2)', async () => {
    const note = await createNote(vaultId, { type: 'docs', name: 'i2', body: 'one' })
    await expectRevisionAtSeq(note.id)
    await updateNote(vaultId, 'docs/i2', { body: 'two' }, agent())
    await expectRevisionAtSeq(note.id)
    await renameNote(vaultId, 'docs/i2', 'i2-moved', agent())
    await expectRevisionAtSeq(note.id)
    await softDeleteNote(vaultId, 'docs/i2-moved', agent())
    await expectRevisionAtSeq(note.id)
    await restoreNote(vaultId, note.id, agent())
    await expectRevisionAtSeq(note.id)
    const first = (await state(note.id)).revisions.find((r) => r.action === 'create')!
    const [created] = (await db.execute(
      sql`SELECT id FROM note_revisions WHERE note_id = ${note.id} AND action = 'create'`,
    )) as unknown as Array<{ id: string }>
    await revertNote(vaultId, 'docs/i2-moved', created!.id, agent())
    await expectRevisionAtSeq(note.id)
    expect((await readNote(vaultId, 'docs/i2-moved'))!.body).toBe(first.body)
  })

  it('credits edit_note to the agent: no `collab` revision stores the same state first (#403)', async () => {
    await createNote(vaultId, { type: 'docs', name: 'credit', body: 'before' })
    const actor = agent()
    const row = await writeThroughCollab(vaultId, 'docs/credit', { body: 'after' }, actor)
    const { revisions } = await state(row!.id)
    expect(revisions.map((r) => [r.action, r.actor_type])).toEqual([
      ['create', 'collab'],
      ['update', 'mcp'],
    ])
    expect(revisions.at(-1)!.actor_id).toBe(actor.id)
  })

  it('leaves row, revision and links untouched when the write dies before COMMIT', async () => {
    const note = await createNote(vaultId, { type: 'docs', name: 'rollback', body: 'kept [[docs/a]]' })
    const before = await state(note.id)
    crashAt('edit.before-commit')
    await expect(updateNote(vaultId, 'docs/rollback', { body: 'lost [[docs/b]]' }, agent())).rejects.toThrow(FailpointError)
    setFailpointHandler(null)
    expect(await state(note.id)).toEqual(before)
    const links = (await db.execute(sql`SELECT target_path FROM note_links WHERE source_note_id = ${note.id}`)) as unknown as Array<{
      target_path: string
    }>
    expect(links.map((l) => l.target_path)).toEqual(['docs/a'])
  })

  it('a write committed before the file is written: the row is the truth, and the projector writes the file', async () => {
    crashAt('create.after-commit-before-file')
    await expect(createNote(vaultId, { type: 'docs', name: 'no-file-yet', body: 'committed' })).rejects.toThrow(FailpointError)
    setFailpointHandler(null)
    expect((await readNote(vaultId, 'docs/no-file-yet'))!.body).toBe('committed')
    const pending = await checkNoteFiles(vaultId)
    expect(pending.pending.some((p) => p.path === 'docs/no-file-yet' && p.projection === 'file')).toBe(true)
    expect(pending.problems).toEqual([])
    await flushProjections()
    expect(await readFile(file('docs', 'no-file-yet.md'), 'utf8')).toContain('committed')
    expect((await checkNoteFiles(vaultId)).pending).toEqual([])
  })

  it('reads the row, not the file: a damaged file does not change what read_note serves', async () => {
    await createNote(vaultId, { type: 'docs', name: 'damaged-read', body: 'row body' })
    await flushProjections()
    await writeFile(file('docs', 'damaged-read.md'), 'no fence at all')
    expect((await readNote(vaultId, 'docs/damaged-read'))!.body).toBe('row body')
    // Repaired by the next write's projection (with a conflict copy of the damaged bytes).
    await updateNote(vaultId, 'docs/damaged-read', { body: 'row body 2' }, agent())
    await flushProjections()
    expect(await readFile(file('docs', 'damaged-read.md'), 'utf8')).toContain('row body 2')
  })
})

describe('projector: files owned by path (ADR-003 §7)', () => {
  it('copies a hand-edited file to .conflicts/ before it overwrites it', async () => {
    await createNote(vaultId, { type: 'hand', name: 'edited', body: 'v1' })
    await flushProjections()
    await writeFile(file('hand', 'edited.md'), serializeNote({ frontmatter: { type: 'hand' }, body: 'typed by hand' }))
    await updateNote(vaultId, 'hand/edited', { body: 'v2' }, agent())
    await flushProjections()
    expect(await readFile(file('hand', 'edited.md'), 'utf8')).toContain('v2')
    const copies = await readdir(file('.conflicts', 'hand'))
    const copy = copies.find((c) => c.startsWith('edited.'))!
    expect(await readFile(file('.conflicts', 'hand', copy), 'utf8')).toContain('typed by hand')
  })

  it('adopts a file whose content equals the row (other key order) without rewriting it', async () => {
    const note = await createNote(vaultId, { type: 'adopt', name: 'order', frontmatter: { title: 'T', status: 'draft' }, body: 'b' })
    await flushProjections()
    const fm = (await readNote(vaultId, 'adopt/order'))!.frontmatter
    const reordered = serializeNote({ frontmatter: Object.fromEntries(Object.entries(fm).reverse()) as typeof fm, body: 'b' })
    await writeFile(file('adopt', 'order.md'), reordered)
    await db.execute(sql`DELETE FROM projected_files WHERE owner_id = ${note.id}`)
    await db.execute(sql`UPDATE note_projections SET applied_seq = 0 WHERE note_id = ${note.id}`)
    await flushProjections()
    expect(await readFile(file('adopt', 'order.md'), 'utf8')).toBe(reordered)
    await expect(readdir(file('.conflicts', 'adopt'))).rejects.toThrow()
    // The file's key order becomes the note's.
    expect(Object.keys((await readNote(vaultId, 'adopt/order'))!.frontmatter)).toEqual(Object.keys(fm).reverse())
  })

  it('rename A→B then a new A: the new note keeps its file, B gets the moved note', async () => {
    await createNote(vaultId, { type: 'race', name: 'a', body: 'old a' })
    await flushProjections()
    await renameNote(vaultId, 'race/a', 'b', agent())
    await createNote(vaultId, { type: 'race', name: 'a', body: 'new a' })
    await flushProjections()
    expect(await readFile(file('race', 'a.md'), 'utf8')).toContain('new a')
    expect(await readFile(file('race', 'b.md'), 'utf8')).toContain('old a')
    expect((await checkNoteFiles(vaultId)).problems).toEqual([])
  })

  it('moves a deleted note to .trash/<id>.md and back on restore; purge removes it', async () => {
    const note = await createNote(vaultId, { type: 'trash', name: 'cycle', body: 'x' })
    await softDeleteNote(vaultId, 'trash/cycle', agent())
    await flushProjections()
    await expect(readFile(file('trash', 'cycle.md'))).rejects.toThrow()
    expect(await readFile(file('.trash', `${note.id}.md`), 'utf8')).toContain('x')
    await restoreNote(vaultId, note.id, agent())
    await flushProjections()
    expect(await readFile(file('trash', 'cycle.md'), 'utf8')).toContain('x')
    await softDeleteNote(vaultId, 'trash/cycle', agent())
    await purgeNote(vaultId, note.id)
    await flushProjections()
    await expect(readFile(file('.trash', `${note.id}.md`))).rejects.toThrow()
  })

  it('writes the index.md of a folder from the rows, including both folders of a move', async () => {
    await createNote(vaultId, { type: 'idx', name: 'one', body: '' })
    await createNote(vaultId, { type: 'idx2', name: 'two', body: '' })
    await flushProjections()
    await renameNote(vaultId, 'idx/one', 'idx2/one', agent())
    await flushProjections()
    await expect(readFile(file('idx', 'index.md'))).rejects.toThrow()
    const index = await readFile(file('idx2', 'index.md'), 'utf8')
    expect(index).toContain('[[idx2/one]]')
    expect(index).toContain('[[idx2/two]]')
  })
})

describe('rename: referrers fixed in the transaction (§5.5)', () => {
  it('rewrites the links of the notes that linked to the old path, credited to the renaming actor', async () => {
    await createNote(vaultId, { type: 'ref', name: 'target', body: '' })
    const referrer = await createNote(vaultId, { type: 'ref', name: 'from', body: 'see [[ref/target]]' })
    const actor = agent()
    await renameNote(vaultId, 'ref/target', 'moved', actor)
    expect((await readNote(vaultId, 'ref/from'))!.body).toBe('see [[ref/moved]]')
    const { revisions } = await state(referrer.id)
    expect(revisions.at(-1)).toMatchObject({ actor_type: 'mcp', actor_id: actor.id })
  })

  it('resumes the referrer refactor after a crash between the rename and the rewrite', async () => {
    await createNote(vaultId, { type: 'ref2', name: 'target', body: '' })
    await createNote(vaultId, { type: 'ref2', name: 'from', body: 'see [[ref2/target]]' })
    crashAt('rename.after-commit-before-refactor')
    await expect(renameNote(vaultId, 'ref2/target', 'moved', agent())).rejects.toThrow(FailpointError)
    setFailpointHandler(null)
    expect((await readNote(vaultId, 'ref2/from'))!.body).toBe('see [[ref2/target]]')
    // The process died holding the job's lease: once it runs out, the projector takes the job.
    await db.execute(sql`UPDATE jobs SET lease_until = now() - interval '1 second' WHERE kind = 'store_rename_refactor' AND done_at IS NULL`)
    // A new note created at the old path afterwards keeps its incoming links' targets out of the job.
    await flushProjections()
    expect((await readNote(vaultId, 'ref2/from'))!.body).toBe('see [[ref2/moved]]')
  })
})

describe('.crdt bins of notes no editor has open (§5.2, S2a)', () => {
  it('keeps the bin equal to the row, as a diff from the bin\'s own text', async () => {
    await createNote(vaultId, { type: 'bin', name: 'kept', body: 'hello world' })
    const doc = new Y.Doc()
    doc.getText('body').insert(0, 'hello world')
    doc.getMap('frontmatter').set('type', 'bin')
    await saveCrdtState(vaultId, 'bin/kept', Y.encodeStateAsUpdate(doc))
    const original = doc.getText('body')
    const item = Y.createRelativePositionFromTypeIndex(original, 6)
    await updateNote(vaultId, 'bin/kept', { body: 'hello brave world' }, agent())
    const saved = new Y.Doc()
    Y.applyUpdate(saved, await readFile(crdtFile(vaultId, 'bin/kept')))
    expect(saved.getText('body').toString()).toBe('hello brave world')
    // The bin's own items survive: a diff, not a delete-all/insert-all.
    expect(Y.createAbsolutePositionFromRelativePosition(item, saved)?.index).toBe(12)
  })
})

describe('backfill and boot reconciliation (§7 step 3, §8)', () => {
  it('fills in projection rows and a revision at seq for rows written around the store', async () => {
    const id = randomUUID()
    await db.execute(sql`
      INSERT INTO notes (id, vault_id, type, name, path, frontmatter, body)
      VALUES (${id}, ${vaultId}, 'old', 'code', 'old/code', '{"type":"old"}'::jsonb, 'written by old code')`)
    await mkdir(file('old'), { recursive: true })
    await writeFile(file('old', 'code.md'), serializeNote({ frontmatter: { type: 'old' }, body: 'written by old code' }))
    await reconcileStore()
    await expectRevisionAtSeq(id)
    await flushProjections()
    const projected = (await db.execute(sql`SELECT applied_seq FROM note_projections WHERE note_id = ${id} AND projection = 'file'`)) as unknown as Array<{
      applied_seq: string
    }>
    expect(projected[0]!.applied_seq).toBe('1')
    await expect(readdir(file('.conflicts', 'old'))).rejects.toThrow()
  })

  it('backfill: the file wins over a differing row and the row is kept as a revision; reruns skip done notes', async () => {
    const id = randomUUID()
    await db.execute(sql`
      INSERT INTO notes (id, vault_id, type, name, path, frontmatter, body)
      VALUES (${id}, ${vaultId}, 'mig', 'conflict', 'mig/conflict', '{"type":"mig"}'::jsonb, 'row text')`)
    await mkdir(file('mig'), { recursive: true })
    await writeFile(file('mig', 'conflict.md'), serializeNote({ frontmatter: { type: 'mig' }, body: 'file text' }))
    const report = await runStoreBackfill()
    expect(report.conflicts.some((c) => c.noteId === id)).toBe(true)
    expect((await readNote(vaultId, 'mig/conflict'))!.body).toBe('file text')
    const { revisions } = await state(id)
    expect(revisions.map((r) => r.action)).toEqual(expect.arrayContaining(['migration:row-kept', 'migration:file']))
    expect(revisions.find((r) => r.action === 'migration:row-kept')!.body).toBe('row text')
    await expectRevisionAtSeq(id)
    const again = await runStoreBackfill()
    expect(again.conflicts.some((c) => c.noteId === id)).toBe(false)
  })

  it('backfill resumes after a crash mid-batch', async () => {
    const ids = [randomUUID(), randomUUID()]
    for (const [i, id] of ids.entries()) {
      await db.execute(sql`
        INSERT INTO notes (id, vault_id, type, name, path, frontmatter, body)
        VALUES (${id}, ${vaultId}, 'resume', ${`n${i}`}, ${`resume/n${i}`}, '{"type":"resume"}'::jsonb, 'x')`)
    }
    let seen = 0
    setFailpointHandler((point) => {
      if (point === 'migration.mid-batch' && ++seen === 1) throw new FailpointError(point)
    })
    await expect(runStoreBackfill()).rejects.toThrow(FailpointError)
    setFailpointHandler(null)
    await runStoreBackfill()
    for (const id of ids) {
      const rows = (await db.execute(sql`SELECT 1 FROM note_projections WHERE note_id = ${id}`)) as unknown as unknown[]
      expect(rows.length).toBe(2)
      await expectRevisionAtSeq(id)
    }
    await flushProjections()
  })

  it('a projection claim a killed process left does not hold its file back after the next boot', async () => {
    await db.execute(sql`INSERT INTO instance_state (id, store_migrated_at) VALUES ('singleton', now()) ON CONFLICT (id) DO UPDATE SET store_migrated_at = now()`)
    const note = await createNote(vaultId, { type: 'lease', name: 'orphan', body: 'one' })
    await flushProjections()
    // What claimProjections leaves when the process dies before the file write
    // (set before the write, so its own wake-up cannot write the file first).
    await db.execute(sql`UPDATE note_projections SET lease_until = now() + interval '60 seconds', attempts = 1 WHERE note_id = ${note.id}`)
    await updateNote(vaultId, 'lease/orphan', { body: 'two' }, agent())
    await flushProjections()
    expect(await readFile(file('lease', 'orphan.md'), 'utf8')).toContain('one')
    await bootStore()
    expect(await readFile(file('lease', 'orphan.md'), 'utf8')).toContain('two')
  })

  it('a note whose backfill failed is backfilled at the next boot (the file still wins), not skipped as done', async () => {
    const id = randomUUID()
    await db.execute(sql`UPDATE instance_state SET store_migrated_at = NULL`)
    await db.execute(sql`
      INSERT INTO notes (id, vault_id, type, name, path, frontmatter, body)
      VALUES (${id}, ${vaultId}, 'failed', 'once', 'failed/once', '{"type":"failed"}'::jsonb, 'row text')`)
    await mkdir(file('failed'), { recursive: true })
    await writeFile(file('failed', 'once.md'), serializeNote({ frontmatter: { type: 'failed' }, body: 'file text' }))
    await chmod(file('failed', 'once.md'), 0o000)
    try {
      expect((await bootStore()).migrated).toBe(false)
      const rows = (await db.execute(sql`SELECT 1 FROM note_projections WHERE note_id = ${id}`)) as unknown as unknown[]
      expect(rows).toHaveLength(0)
    } finally {
      await chmod(file('failed', 'once.md'), 0o644)
    }
    expect((await bootStore()).migrated).toBe(true)
    expect((await readNote(vaultId, 'failed/once'))!.body).toBe('file text')
    await expectRevisionAtSeq(id)
  })

  it('backfill file-wins replaces the links and queues an embedding of the file text', async () => {
    const id = randomUUID()
    await db.execute(sql`
      INSERT INTO notes (id, vault_id, type, name, path, frontmatter, body)
      VALUES (${id}, ${vaultId}, 'linked', 'wins', 'linked/wins', '{"type":"linked"}'::jsonb, 'see [[docs/old]]')`)
    await db.execute(sql`INSERT INTO note_links (source_note_id, target_path) VALUES (${id}, 'docs/old')`)
    await mkdir(file('linked'), { recursive: true })
    await writeFile(file('linked', 'wins.md'), serializeNote({ frontmatter: { type: 'linked' }, body: 'see [[docs/new]]' }))
    await runStoreBackfill()
    const links = (await db.execute(sql`SELECT target_path FROM note_links WHERE source_note_id = ${id}`)) as unknown as Array<{
      target_path: string
    }>
    expect(links.map((l) => l.target_path)).toEqual(['docs/new'])
    const jobs = (await db.execute(sql`SELECT 1 FROM jobs WHERE kind = 'embed_note' AND payload->>'noteId' = ${id}`)) as unknown as unknown[]
    expect(jobs.length).toBeGreaterThan(0)
    await flushProjections()
  })
})

describe('purge (§5.5)', () => {
  it('a deleted then purged note leaves its folder index.md', async () => {
    await createNote(vaultId, { type: 'pf', name: 'keep', body: '' })
    const gone = await createNote(vaultId, { type: 'pf', name: 'gone', body: '' })
    await flushProjections()
    await softDeleteNote(vaultId, 'pf/gone', agent())
    await purgeNote(vaultId, gone.id)
    await flushProjections()
    const index = await readFile(file('pf', 'index.md'), 'utf8')
    expect(index).toContain('[[pf/keep]]')
    expect(index).not.toContain('pf/gone')
  })
})
