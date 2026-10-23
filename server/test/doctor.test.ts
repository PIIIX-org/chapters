import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import postgres from 'postgres'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as Y from 'yjs'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { db } from '../src/db/client.js'
import { INSTANCE_LOCK_KEY } from '../src/notes/maintenance-lock.js'
import { runDoctor, type DoctorClass, type DoctorReport } from '../src/notes/doctor.js'
import { parseNote, serializeNote, type Frontmatter } from '../src/notes/okf.js'
import { flushProjections } from '../src/notes/projector.js'
import { createNote, noteFile, softDeleteNote, vaultDir } from '../src/notes/store.js'
import { flushEmbeddings, kickEmbeddings } from '../src/search/embedding-queue.js'
import { seedDocument } from '../src/sync/note-crdt.js'
import { createActiveUser, loginCookie } from './helpers.js'

// ADR-003 S6 (#495): the doctor compares file, row, revision, CRDT, FTS,
// vectors, links and projections. One note per mismatch class; each test
// damages one copy, expects exactly that class, and (where repairable)
// repairs it and expects the vault clean again.

let app: FastifyInstance
let vaultId: string
const ids: Record<string, string> = {}
const NAMES = [
  'healthy',
  'vanished',
  'garbled',
  'rebodied',
  'reordered',
  'unrecorded',
  'unprojected',
  'failing',
  'outdated',
  'unrevised',
  'misrevised',
  'binned',
  'crdt',
  'crdtowned',
  'folding',
  'fts',
  'unvectored',
  'misvectored',
  'unlinked',
]

let collabMigratedBefore: string | null = null

beforeAll(async () => {
  const [state] = (await db.execute(sql`SELECT collab_migrated_at FROM instance_state WHERE id = 'singleton'`)) as unknown as Array<{
    collab_migrated_at: string | null
  }>
  collabMigratedBefore = state?.collab_migrated_at ?? null
  app = await buildApp()
  await app.ready()
  const owner = await createActiveUser()
  const cookie = await loginCookie(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'Doctor vault' } })).json().id
  for (const name of NAMES) {
    const row = await createNote(vaultId, {
      path: `checks/${name}`,
      frontmatter: { status: 'draft', tags: ['a', 'b'], title: name },
      body: `${name} body, links [[checks/healthy]]`,
    })
    ids[name] = row.id
  }
  await flushProjections()
  await flushEmbeddings()
})

afterAll(async () => {
  await db.execute(sql`UPDATE instance_state SET collab_migrated_at = ${collabMigratedBefore} WHERE id = 'singleton'`)
  await flushProjections()
  await app.close()
})

const path = (name: string) => `checks/${name}`
const file = (name: string) => noteFile(vaultId, path(name))
const doctor = (repair = false) => runDoctor({ vaultId, repair })

function classesOf(report: DoctorReport, at?: string): string[] {
  return report.problems.filter((p) => !at || p.path === at || p.path === `${at}.md`).map((p) => p.class)
}

async function noteState(name: string): Promise<{ seq: string; body: string; frontmatter: unknown }> {
  const [row] = (await db.execute(sql`SELECT seq, body, frontmatter FROM notes WHERE id = ${ids[name]}`)) as unknown as Array<{
    seq: string
    body: string
    frontmatter: unknown
  }>
  return row!
}

/** Runs the doctor, expects only `cls` at `name`, repairs, lets the workers run, and expects the vault clean with the row untouched. */
async function expectRepaired(name: string, cls: DoctorClass, conflictCopy = false): Promise<void> {
  const before = await noteState(name)
  expect(classesOf(await doctor())).toEqual([cls])
  const repaired = await doctor(true)
  expect(repaired.problems).toEqual([expect.objectContaining({ class: cls, repairable: true, repaired: true })])
  await flushProjections()
  kickEmbeddings()
  await flushEmbeddings()
  expect(classesOf(await doctor())).toEqual(conflictCopy ? ['conflict-copy'] : [])
  await rm(join(vaultDir(vaultId), '.conflicts'), { recursive: true, force: true })
  expect(await noteState(name)).toEqual(before)
}

async function setCollabMigrated(done: boolean): Promise<void> {
  await db.execute(sql`
    INSERT INTO instance_state (id, collab_migrated_at) VALUES ('singleton', ${done ? sql`now()` : sql`NULL`})
    ON CONFLICT (id) DO UPDATE SET collab_migrated_at = EXCLUDED.collab_migrated_at`)
}

function docBytes(body: string, frontmatter: Record<string, unknown>): Uint8Array {
  const doc = new Y.Doc()
  doc.getText('body').insert(0, body)
  const map = doc.getMap('frontmatter')
  for (const [k, v] of Object.entries(frontmatter)) map.set(k, v)
  const bytes = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return bytes
}

async function writeVaultFile(rel: string, bytes: string | Uint8Array): Promise<void> {
  const target = join(vaultDir(vaultId), rel)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, bytes)
}

describe('doctor', () => {
  it('reports a consistent vault as clean, with nothing pending', async () => {
    const report = await doctor()
    expect(report.problems).toEqual([])
    expect(report.pending).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.checked.notes).toBe(NAMES.length)
  })

  it('is read-only without --repair', async () => {
    await rm(file('vanished'))
    const projections = () => db.execute(sql`SELECT * FROM note_projections WHERE note_id = ${ids.vanished} ORDER BY projection`)
    const before = await projections()
    expect(classesOf(await doctor())).toEqual(['file-missing'])
    expect(await projections()).toEqual(before)
  })

  it('file-missing: re-raises the file projection', async () => {
    await expectRepaired('vanished', 'file-missing')
    expect(parseNote(await readFile(file('vanished'), 'utf8')).body).toBe('vanished body, links [[checks/healthy]]')
  })

  it('file-unparseable', async () => {
    await writeFile(file('garbled'), '## no frontmatter fence\n')
    await expectRepaired('garbled', 'file-unparseable', true)
  })

  it('file-differs: content different from the row; the repair keeps a conflict copy', async () => {
    const note = parseNote(await readFile(file('rebodied'), 'utf8'))
    note.body = 'edited on disk'
    await writeFile(file('rebodied'), serializeNote(note))
    const report = await doctor()
    expect(report.problems).toEqual([expect.objectContaining({ class: 'file-differs', path: 'checks/rebodied.md', noteId: ids.rebodied })])
    await doctor(true)
    await flushProjections()
    const after = await doctor()
    expect(classesOf(after)).toEqual(['conflict-copy'])
    expect(parseNote(await readFile(file('rebodied'), 'utf8')).body).toBe('rebodied body, links [[checks/healthy]]')
    await rm(join(vaultDir(vaultId), '.conflicts'), { recursive: true, force: true })
    expect((await doctor()).problems).toEqual([])
  })

  it('file-edited: same content, bytes the projector did not write', async () => {
    const note = parseNote(await readFile(file('reordered'), 'utf8'))
    note.frontmatter = Object.fromEntries(Object.entries(note.frontmatter).reverse()) as Frontmatter
    await writeFile(file('reordered'), serializeNote(note))
    await expectRepaired('reordered', 'file-edited')
  })

  it('file-unrecorded: no projected_files record', async () => {
    await db.execute(sql`DELETE FROM projected_files WHERE vault_id = ${vaultId} AND path = 'checks/unrecorded.md'`)
    await expectRepaired('unrecorded', 'file-unrecorded')
  })

  it('file-orphan and conflict-copy are reported, not repaired', async () => {
    await writeVaultFile('stray/lost.md', '---\ntype: stray\n---\nlost\n')
    await writeVaultFile('.conflicts/checks/healthy.20261021T000000000Z.md', 'old bytes')
    const report = await doctor(true)
    expect(report.problems.map((p) => [p.class, p.path, p.repairable, p.repaired])).toEqual([
      ['file-orphan', 'stray/lost.md', false, undefined],
      ['conflict-copy', '.conflicts/checks/healthy.20261021T000000000Z.md', false, undefined],
    ])
    await rm(join(vaultDir(vaultId), 'stray'), { recursive: true })
    await rm(join(vaultDir(vaultId), '.conflicts'), { recursive: true })
  })

  it('file-missing for a generated index.md: re-renders it', async () => {
    await rm(join(vaultDir(vaultId), 'checks/index.md'))
    const report = await doctor(true)
    expect(report.problems).toEqual([expect.objectContaining({ class: 'file-missing', path: 'checks/index.md', noteId: null, repaired: true })])
    await flushProjections()
    expect((await doctor()).problems).toEqual([])
  })

  it('projection-missing', async () => {
    await db.execute(sql`DELETE FROM note_projections WHERE note_id = ${ids.unprojected} AND projection = 'file'`)
    await expectRepaired('unprojected', 'projection-missing')
  })

  it('projection-failed: retried with --repair; pending without an error is not a problem', async () => {
    await db.execute(sql`
      UPDATE note_projections SET applied_seq = 0, last_error = 'Error: disk full', attempts = 3, lease_until = now() + interval '1 hour'
      WHERE note_id = ${ids.failing} AND projection = 'file'`)
    expect((await doctor()).problems).toEqual([
      expect.objectContaining({ class: 'projection-failed', detail: expect.stringContaining('disk full') }),
    ])
    await db.execute(sql`UPDATE note_projections SET last_error = NULL WHERE note_id = ${ids.failing} AND projection = 'file'`)
    const quiet = await doctor()
    expect(quiet.problems).toEqual([])
    expect(quiet.pending).toEqual([expect.objectContaining({ kind: 'projection', path: 'checks/failing' })])
    await db.execute(sql`UPDATE note_projections SET last_error = 'Error: disk full' WHERE note_id = ${ids.failing} AND projection = 'file'`)
    await expectRepaired('failing', 'projection-failed')
  })

  it('projection-outdated', async () => {
    await db.execute(sql`UPDATE note_projections SET index_version = 0 WHERE note_id = ${ids.outdated} AND projection = 'file'`)
    await expectRepaired('outdated', 'projection-outdated')
  })

  it('revision-missing and revision-differs are report-only', async () => {
    const { seq } = await noteState('unrevised')
    await db.execute(sql`UPDATE note_revisions SET seq = NULL WHERE note_id = ${ids.unrevised} AND seq = ${seq}`)
    await db.execute(sql`UPDATE note_revisions SET body = 'not the row' WHERE note_id = ${ids.misrevised}`)
    const report = await doctor(true)
    expect(report.problems.map((p) => [p.class, p.path, p.repaired])).toEqual(
      expect.arrayContaining([
        ['revision-missing', 'checks/unrevised', undefined],
        ['revision-differs', 'checks/misrevised', undefined],
      ]),
    )
    expect(report.problems).toHaveLength(2)
    await db.execute(sql`UPDATE note_revisions SET seq = ${seq} WHERE note_id = ${ids.unrevised} AND seq IS NULL`)
    await db.execute(sql`UPDATE note_revisions r SET body = n.body FROM notes n WHERE n.id = r.note_id AND r.note_id = ${ids.misrevised}`)
    expect((await doctor()).problems).toEqual([])
  })

  it('crdt-bin-differs, crdt-bin-undecodable and crdt-bin-orphan, while the S2b collab backfill has not finished', async () => {
    await setCollabMigrated(false)
    const { frontmatter } = await noteState('binned')
    await writeVaultFile('.crdt/checks/binned.bin', docBytes('typed in the editor', frontmatter as Record<string, unknown>))
    await writeVaultFile('.crdt/checks/healthy.bin', new Uint8Array([255, 255, 255, 255, 255, 255, 255]))
    await writeVaultFile('.crdt/checks/gone.bin', docBytes('x', {}))
    const report = await doctor(true)
    expect(report.problems.map((p) => [p.class, p.path, p.repaired])).toEqual([
      ['crdt-bin-differs', '.crdt/checks/binned.bin', undefined],
      ['crdt-bin-orphan', '.crdt/checks/gone.bin', undefined],
      ['crdt-bin-undecodable', '.crdt/checks/healthy.bin', undefined],
    ])
    expect(report.problems[0]!.detail).toMatch(/body/)
    // A bin that holds the row's text is fine.
    const row = await noteState('binned')
    await writeVaultFile('.crdt/checks/binned.bin', docBytes(row.body, row.frontmatter as Record<string, unknown>))
    await rm(join(vaultDir(vaultId), '.crdt/checks/healthy.bin'))
    await rm(join(vaultDir(vaultId), '.crdt/checks/gone.bin'))
    expect((await doctor()).problems).toEqual([])
    expect((await doctor()).checked.bins).toBe(1)
    await rm(join(vaultDir(vaultId), '.crdt'), { recursive: true })
  })

  it('a bin S2b no longer reads is not a problem: its note has note_crdt state, or the collab backfill finished', async () => {
    const row = await noteState('crdtowned')
    await db.execute(sql`
      INSERT INTO note_crdt (note_id, snapshot, folded_seq)
      VALUES (${ids.crdtowned}, ${Buffer.from(Y.encodeStateAsUpdate(seedDocument(ids.crdtowned!, { frontmatter: row.frontmatter as Record<string, unknown>, body: row.body })))}, ${row.seq})`)
    await writeVaultFile('.crdt/checks/crdtowned.bin', docBytes('an old path-named state', {}))
    await writeVaultFile('.crdt/checks/binned.bin', docBytes('typed before S2b', {}))
    await setCollabMigrated(false)
    // Before the backfill finishes: only the bin of the note without note_crdt state is still to be read.
    const before = await doctor()
    expect(before.problems.map((p) => [p.class, p.path])).toEqual([['crdt-bin-differs', '.crdt/checks/binned.bin']])
    expect(before.checked.bins).toBe(1)
    // After it: no bin is read again; a rollback's bins are merged by the next boot.
    await setCollabMigrated(true)
    const after = await doctor()
    expect(after.problems).toEqual([])
    expect(after.pending.map((p) => [p.kind, p.path])).toEqual([
      ['crdt-bin', '.crdt/checks/binned.bin'],
      ['crdt-bin', '.crdt/checks/crdtowned.bin'],
    ])
    await rm(join(vaultDir(vaultId), '.crdt'), { recursive: true })
    await db.execute(sql`DELETE FROM note_crdt WHERE note_id = ${ids.crdtowned}`)
  })

  it('crdt-tail-stale and crdt-fold-error: acknowledged typing left unfolded; --repair folds it into the row as boot does', async () => {
    const row = await noteState('folding')
    const seed = seedDocument(ids.folding!, { frontmatter: row.frontmatter as Record<string, unknown>, body: row.body })
    await db.execute(sql`
      INSERT INTO note_crdt (note_id, snapshot, folded_seq) VALUES (${ids.folding}, ${Buffer.from(Y.encodeStateAsUpdate(seed))}, ${row.seq})`)
    const typed = new Y.Doc()
    Y.applyUpdate(typed, Y.encodeStateAsUpdate(seed))
    typed.getText('body').insert(row.body.length, ' and typed in the editor')
    const update = Y.encodeStateAsUpdate(typed, Y.encodeStateVector(seed))
    await db.execute(sql`INSERT INTO note_updates (note_id, update, actor_type) VALUES (${ids.folding}, ${Buffer.from(update)}, 'collab')`)
    // Fresh typing is work in flight.
    const fresh = await doctor()
    expect(fresh.problems).toEqual([])
    expect(fresh.pending).toEqual([expect.objectContaining({ kind: 'crdt-tail', path: 'checks/folding' })])
    // Left unfolded past STALE_TAIL_MINUTES, with a fold error: problems, repairable.
    await db.execute(sql`UPDATE note_updates SET created_at = now() - interval '1 hour' WHERE note_id = ${ids.folding}`)
    await db.execute(sql`UPDATE note_crdt SET fold_error = 'boot fold failed: Error: test' WHERE note_id = ${ids.folding}`)
    expect(classesOf(await doctor())).toEqual(['crdt-fold-error', 'crdt-tail-stale'])
    const repaired = await doctor(true)
    expect(repaired.problems.map((p) => [p.class, p.repaired])).toEqual([
      ['crdt-fold-error', true],
      ['crdt-tail-stale', true],
    ])
    expect((await noteState('folding')).body).toBe(`${row.body} and typed in the editor`)
    await flushProjections()
    kickEmbeddings()
    await flushEmbeddings()
    expect((await doctor()).problems).toEqual([])
    seed.destroy()
    typed.destroy()
    await db.execute(sql`DELETE FROM note_crdt WHERE note_id = ${ids.folding}`)
  })

  it('note_crdt: fold error, rejected update, snapshot that differs, and an unfolded tail as pending', async () => {
    const row = await noteState('crdt')
    const fm = row.frontmatter as Record<string, unknown>
    await db.execute(sql`
      INSERT INTO note_crdt (note_id, snapshot, folded_seq) VALUES (${ids.crdt}, ${Buffer.from(docBytes(row.body, fm))}, ${row.seq})`)
    expect((await doctor()).problems).toEqual([])
    expect((await doctor()).checked.crdtRows).toBe(1)

    await db.execute(sql`UPDATE note_crdt SET snapshot = ${Buffer.from(docBytes('other text', fm))}, fold_error = 'Error: bad update' WHERE note_id = ${ids.crdt}`)
    const [rejected] = (await db.execute(sql`
      INSERT INTO note_updates (note_id, update, actor_type, rejected_at, reject_reason)
      VALUES (${ids.crdt}, ${Buffer.from([1, 2, 3])}, 'collab', now(), 'does not apply') RETURNING id`)) as unknown as Array<{ id: string }>
    await db.execute(sql`UPDATE note_crdt SET folded_through = ${rejected!.id} WHERE note_id = ${ids.crdt}`)
    expect(classesOf(await doctor(true))).toEqual(['crdt-fold-error', 'crdt-rejected-update', 'crdt-snapshot-differs'])

    await db.execute(sql`INSERT INTO note_updates (note_id, update, actor_type) VALUES (${ids.crdt}, ${Buffer.from(docBytes('', {}))}, 'collab')`)
    const tail = await doctor()
    expect(classesOf(tail)).toEqual(['crdt-fold-error', 'crdt-rejected-update'])
    expect(tail.pending).toEqual([expect.objectContaining({ kind: 'crdt-tail', path: 'checks/crdt' })])
    await db.execute(sql`DELETE FROM note_updates WHERE note_id = ${ids.crdt}`)
    await db.execute(sql`DELETE FROM note_crdt WHERE note_id = ${ids.crdt}`)
    expect(await noteState('crdt')).toEqual(row)
  })

  it('fts-stale: a stored fts vector that is not the row', async () => {
    // fts is a generated column; drop the expression inside a rolled-back transaction to fake corruption.
    let report: DoctorReport | undefined
    await db
      .transaction(async (tx) => {
        await tx.execute(sql`ALTER TABLE notes ALTER COLUMN fts DROP EXPRESSION`)
        await tx.execute(sql`UPDATE notes SET fts = to_tsvector('english', 'stale') WHERE id = ${ids.fts}`)
        report = await runDoctor({ vaultId, client: tx })
        throw new Error('rollback')
      })
      .catch((err: unknown) => {
        if (!(err instanceof Error && err.message === 'rollback')) throw err
      })
    expect(report!.problems).toEqual([expect.objectContaining({ class: 'fts-stale', path: 'checks/fts', repairable: false })])
    expect((await doctor()).problems).toEqual([])
  })

  it('vector-missing: queues an embedding job', async () => {
    await db.execute(sql`UPDATE notes SET embedding = NULL WHERE id = ${ids.unvectored}`)
    await db.execute(sql`DELETE FROM jobs WHERE kind = 'embed_note' AND payload->>'noteId' = ${ids.unvectored}`)
    await expectRepaired('unvectored', 'vector-missing')
  })

  it('vector-failed: a job whose runs ended with the process is run again too', async () => {
    await db.execute(sql`
      UPDATE jobs SET done_at = now(), attempts = 3, last_error = 'LeaseExpired: the process running this job stopped before it finished, 3 times'
      WHERE kind = 'embed_note' AND payload->>'noteId' = ${ids.misvectored}`)
    await expectRepaired('misvectored', 'vector-failed')
  })

  it('vector-failed: the job for the current seq failed', async () => {
    await db.execute(sql`
      UPDATE jobs SET done_at = now(), last_error = 'Error: model unavailable'
      WHERE kind = 'embed_note' AND payload->>'noteId' = ${ids.misvectored}`)
    await expectRepaired('misvectored', 'vector-failed')
  })

  it('links-differ: rederives the link rows from the body', async () => {
    await db.execute(sql`DELETE FROM note_links WHERE source_note_id = ${ids.unlinked}`)
    await db.execute(sql`INSERT INTO note_links (source_note_id, target_path) VALUES (${ids.unlinked}, 'nowhere')`)
    // Rows carry the link's body line (#558); a row written without one says so.
    expect((await doctor()).problems[0]!.detail).toBe('missing [checks/healthy#L1], extra [nowhere (no line)]')
    await expectRepaired('unlinked', 'links-differ')
  })

  it('links-differ: one target linked twice from the same line (one stored row) is no problem', async () => {
    // The second link starts on line 1 too but ends on line 2: `linkRows` keeps the first, and so does the check.
    const twice = await createNote(vaultId, { path: 'checks/twice', body: 'see [[checks/healthy]] and [[checks/healthy|two\nlines]]\n' })
    await flushProjections()
    await flushEmbeddings()
    expect((await doctor()).problems.filter((p) => p.noteId === twice.id)).toEqual([])
    await softDeleteNote(vaultId, 'checks/twice')
    await flushProjections()
  })

  it('checks trashed notes against .trash/<id>.md', async () => {
    const trashed = await createNote(vaultId, { path: 'checks/trashed', body: 'to the trash' })
    await softDeleteNote(vaultId, 'checks/trashed')
    await flushProjections()
    await flushEmbeddings()
    expect((await doctor()).problems).toEqual([])
    await rm(join(vaultDir(vaultId), '.trash', `${trashed.id}.md`))
    expect((await doctor()).problems).toEqual([
      expect.objectContaining({ class: 'file-missing', path: `.trash/${trashed.id}.md`, noteId: trashed.id }),
    ])
    await doctor(true)
    await flushProjections()
    expect((await doctor()).problems).toEqual([])
  })

  it('the CLI with --repair holds the shared instance lock: refused (exit 2, nothing written) while maintenance holds it', async () => {
    const other = postgres(config.databaseUrl, { max: 1, onnotice: () => {} })
    const projection = () => db.execute(sql`SELECT applied_seq FROM note_projections WHERE note_id = ${ids.vanished} AND projection = 'file'`)
    try {
      await rm(file('vanished'))
      const before = await projection()
      await other`SELECT pg_advisory_lock(${INSTANCE_LOCK_KEY.toString()}::bigint)`
      const cli = (...args: string[]) =>
        promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/scripts/doctor.ts', '--vault', vaultId, ...args], {
          cwd: join(import.meta.dirname, '..'),
          env: process.env,
        }).then(
          (out) => ({ code: 0, out: out.stdout + out.stderr }),
          (err: { code?: number; stdout?: string; stderr?: string }) => ({ code: err.code ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }),
        )
      const repairRun = await cli('--repair')
      expect(repairRun.out).toContain('maintenance in progress')
      expect(repairRun.code).toBe(2)
      expect(await projection()).toEqual(before)
      // The lock is taken before the report file is created: a refusal leaves no empty file behind.
      const reportFile = join(tmpdir(), `doctor-report-${randomUUID()}.json`)
      expect((await cli('--repair', '--report', reportFile)).code).toBe(2)
      expect(await stat(reportFile).then(() => true, () => false)).toBe(false)
      // Read-only runs take no lock. A file-missing alone is repairable: exit 3 (#908).
      const readRun = await cli()
      expect(readRun.out).toContain('PROBLEM file-missing')
      expect(readRun.code).toBe(3)
    } finally {
      await other`SELECT pg_advisory_unlock_all()`
      await other.end()
    }
    await doctor(true)
    await flushProjections()
    expect((await doctor()).problems).toEqual([])
    // Three CLI processes (tsx start-up each): slow on a loaded machine.
  }, 60_000)

  it('scopes to one vault', async () => {
    const other = randomUUID()
    expect((await runDoctor({ vaultId: other })).checked.notes).toBe(0)
  })
})
