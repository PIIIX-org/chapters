import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { FastifyInstance } from 'fastify'
import * as Y from 'yjs'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { sql } from '../src/db/client.js'
import { planStoreMigration, type StoreMigrationReport } from '../src/notes/migrate-store.js'
import { parseNote, serializeNote } from '../src/notes/okf.js'
import { noteFile, trashFile, vaultDir } from '../src/notes/store.js'
import { crdtFile } from '../src/sync/crdt-store.js'
import { createActiveUser, loginCookie } from './helpers.js'

// ADR-003 S1: `migrate-store --dry-run` classifies every case of §8 on a
// seeded fixture and writes nothing (no row, no file) except its report.

let app: FastifyInstance
let cookie: string
let vaultId: string
const ids: Record<string, string> = {}
const NAMES = [
  'consistent',
  'row-newer',
  'file-newer',
  'no-file',
  'unparseable',
  'hand-formatted',
  'revision-gap',
  'no-revision',
  'bin-row',
  'bin-file',
  'bin-revision',
  'bin-mismatch',
  'bin-garbage',
  'trashed',
] as const

const binOf = (body: string) => {
  const doc = new Y.Doc()
  doc.getText('body').insert(0, body)
  doc.getMap('frontmatter').set('status', 'draft')
  return Y.encodeStateAsUpdate(doc)
}
const path = (name: string) => `guides/${name}`
const writeBin = async (name: string, bytes: Uint8Array) => {
  await mkdir(dirname(crdtFile(vaultId, path(name))), { recursive: true })
  await writeFile(crdtFile(vaultId, path(name)), bytes)
}
const setRow = (name: string, body: string) => sql`update notes set body = ${body}, updated_at = now() where id = ${ids[name]!}`
/** Rewrites a note's file in serializeNote form with a new body, keeping its frontmatter. */
async function writeNoteFile(name: string, body: string): Promise<void> {
  const file = noteFile(vaultId, path(name))
  await writeFile(file, serializeNote({ ...parseNote(await readFile(file, 'utf8')), body }))
}

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  vaultId = (
    await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'Migrate store vault' } })
  ).json().id
  for (const name of NAMES) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/notes`,
      headers: { cookie },
      body: { type: 'guides', name, body: `${name} body`, frontmatter: { status: 'draft' } },
    })
    expect(res.statusCode).toBe(200)
    ids[name] = res.json().id
  }
  // file ≠ row, row newer (the crash class the lab measures: row-new/file-old)
  await utimes(noteFile(vaultId, path('row-newer')), new Date('2020-01-01'), new Date('2020-01-01'))
  await setRow('row-newer', 'row-newer row text')
  // file ≠ row, file newer (a hand edit)
  await writeNoteFile('file-newer', 'file-newer edited by hand')
  await utimes(noteFile(vaultId, path('file-newer')), new Date('2099-01-01'), new Date('2099-01-01'))
  await rm(noteFile(vaultId, path('no-file')))
  await writeFile(noteFile(vaultId, path('unparseable')), 'no fence here\n')
  // same content, other YAML layout: parses to the row, but not serializeNote bytes
  const handFile = noteFile(vaultId, path('hand-formatted'))
  const handBytes = await readFile(handFile, 'utf8')
  expect(handBytes).toContain('status: draft\n')
  await writeFile(handFile, handBytes.replace('status: draft\n', 'status: "draft"   # quoted by hand\n'))
  // row and file agree, the newest revision does not (a write killed before its revision)
  await setRow('revision-gap', 'revision-gap v2')
  await writeNoteFile('revision-gap', 'revision-gap v2')
  await sql`delete from note_revisions where note_id = ${ids['no-revision']!}`
  await writeBin('bin-row', binOf('bin-row body'))
  await setRow('bin-file', 'bin-file row text')
  await writeBin('bin-file', binOf('bin-file body'))
  // the bin holds the created text; row, file and newest revision moved on
  await setRow('bin-revision', 'bin-revision v2')
  await writeNoteFile('bin-revision', 'bin-revision v2')
  await sql`insert into note_revisions (note_id, actor_type, action, frontmatter, body)
            select id, 'user', 'update', frontmatter, body from notes where id = ${ids['bin-revision']!}`
  await writeBin('bin-revision', binOf('bin-revision body'))
  await writeBin('bin-mismatch', binOf('text of a trashed predecessor'))
  await writeBin('bin-garbage', new Uint8Array([0xff, 0xfe, 0x01]))
  expect(
    (await app.inject({ method: 'DELETE', url: `/api/vaults/${vaultId}/notes/${path('trashed')}`, headers: { cookie } }))
      .statusCode,
  ).toBe(200)
  // missing rows: files no note owns
  await writeFile(noteFile(vaultId, 'guides/stray'), serializeNote({ frontmatter: { type: 'guides' } as never, body: 'x' }))
  await writeFile(trashFile(vaultId, '00000000-0000-4000-8000-000000000000'), 'x')
  await writeFile(crdtFile(vaultId, 'guides/gone'), binOf('gone'))
  await writeFile(join(vaultDir(vaultId), 'guides', 'consistent.md.123.0123456789ab.tmp'), '')
})

// The fixture damages files on purpose; take the vault out of the CI
// vault-invariant gate (#578), which checks live vaults only.
afterAll(async () => {
  await sql`update vaults set deleted_at = now() where id = ${vaultId}`
  await app.close()
})

/** Every row of every public table, and every file under DATA_DIR with bytes and mtime. */
interface Snapshot {
  db: Record<string, string>
  files: Record<string, string>
}

async function snapshot(): Promise<Snapshot> {
  const db: Record<string, string> = {}
  const tables = await sql<Array<{ t: string }>>`select tablename as t from pg_tables where schemaname = 'public' order by 1`
  for (const { t } of tables) {
    const [row] = await sql.unsafe(`select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h from "${t}" x`)
    db[t] = row!.h
  }
  const files: Record<string, string> = {}
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) await visit(abs)
      else {
        const info = await stat(abs)
        files[abs] = `${info.mtimeMs}:${createHash('sha256').update(await readFile(abs)).digest('hex')}`
      }
    }
  }
  await visit(config.dataDir)
  return { db, files }
}

describe('planStoreMigration (ADR-003 §8 dry run)', () => {
  let report: StoreMigrationReport
  let before: Snapshot

  beforeAll(async () => {
    before = await snapshot()
    report = await planStoreMigration({ vaultId })
  })

  const entry = (name: string) => report.notes.find((n) => n.noteId === ids[name])!

  it('runs in one read-only snapshot transaction and writes nothing', async () => {
    expect(report.database.readOnlyTransaction).toBe(true)
    expect(report.database.isolation).toBe('repeatable read')
    expect(report.database.schema0021Applied).toBe(true)
    expect(report.database.storeMigratedAt).toBeNull()
    expect(await snapshot()).toEqual(before)
  })

  it('classifies every note of the fixture', () => {
    const shape = (name: string) => {
      const { file, serializeNoteForm, revision, crdt, projection } = entry(name)
      return { file, serializeNoteForm, revision, crdt, projection }
    }
    expect(Object.fromEntries(NAMES.map((name) => [name, shape(name)]))).toEqual({
      consistent: { file: 'consistent', serializeNoteForm: true, revision: 'consistent', crdt: 'missing', projection: 'applied' },
      'row-newer': { file: 'differs', serializeNoteForm: true, revision: 'gap', crdt: 'missing', projection: 'applied' },
      'file-newer': { file: 'differs', serializeNoteForm: true, revision: 'consistent', crdt: 'missing', projection: 'applied' },
      'no-file': { file: 'missing', serializeNoteForm: null, revision: 'consistent', crdt: 'missing', projection: 'create' },
      unparseable: { file: 'unparseable', serializeNoteForm: null, revision: 'consistent', crdt: 'missing', projection: 'rewrite' },
      'hand-formatted': { file: 'consistent', serializeNoteForm: false, revision: 'consistent', crdt: 'missing', projection: 'adopted' },
      'revision-gap': { file: 'consistent', serializeNoteForm: true, revision: 'gap', crdt: 'missing', projection: 'applied' },
      'no-revision': { file: 'consistent', serializeNoteForm: true, revision: 'none', crdt: 'missing', projection: 'applied' },
      'bin-row': { file: 'consistent', serializeNoteForm: true, revision: 'consistent', crdt: 'matches-row', projection: 'applied' },
      'bin-file': { file: 'differs', serializeNoteForm: true, revision: 'gap', crdt: 'matches-file', projection: 'applied' },
      'bin-revision': { file: 'consistent', serializeNoteForm: true, revision: 'consistent', crdt: 'matches-revision', projection: 'applied' },
      'bin-mismatch': { file: 'consistent', serializeNoteForm: true, revision: 'consistent', crdt: 'mismatch', projection: 'applied' },
      'bin-garbage': { file: 'consistent', serializeNoteForm: true, revision: 'consistent', crdt: 'undecodable', projection: 'applied' },
      trashed: { file: 'consistent', serializeNoteForm: true, revision: 'consistent', crdt: null, projection: 'applied' },
    })
    expect(entry('trashed')).toMatchObject({ trashed: true, path: path('trashed') })
    expect(entry('unparseable').detail).toMatch(/fence/)
  })

  it('lists each file ≠ row conflict with row.updated_at against the file mtime and both hashes (Q5: file wins)', () => {
    const conflicts = Object.fromEntries(report.conflicts.map((c) => [c.noteId, c]))
    expect(report.conflicts.map((c) => c.path).sort()).toEqual(
      ['guides/bin-file.md', 'guides/file-newer.md', 'guides/row-newer.md'],
    )
    const rowNewer = conflicts[ids['row-newer']!]!
    expect(rowNewer).toMatchObject({ newer: 'row', bodyDiffers: true, differingFrontmatterKeys: [], resolution: 'file-wins' })
    expect(rowNewer.fileMtime).toBe('2020-01-01T00:00:00.000Z')
    expect(rowNewer.rowHash).not.toBe(rowNewer.fileHash)
    expect(conflicts[ids['file-newer']!]).toMatchObject({ newer: 'file', fileMtime: '2099-01-01T00:00:00.000Z' })
  })

  it('reports files without a row, files that change bytes, counts and timings', () => {
    expect(report.missingRows).toEqual({
      files: [{ vaultId, path: 'guides/stray.md' }],
      trashFiles: [{ vaultId, path: '.trash/00000000-0000-4000-8000-000000000000.md' }],
      bins: [{ vaultId, path: '.crdt/guides/gone.bin' }],
    })
    expect(report.filesThatChangeBytes.map((f) => [f.path, f.reason]).sort()).toEqual([
      ['guides/no-file.md', 'create'],
      ['guides/unparseable.md', 'rewrite'],
    ])
    expect(report.counts).toMatchObject({
      notes: NAMES.length,
      liveNotes: NAMES.length - 1,
      trashedNotes: 1,
      file: { consistent: 9, missing: 1, unparseable: 1, differs: 3 },
      notSerializeNoteForm: 1,
      revision: { consistent: 10, gap: 3, none: 1 },
      crdt: { 'matches-row': 1, 'matches-file': 1, 'matches-revision': 1, mismatch: 1, undecodable: 1, missing: 8 },
      projection: { applied: 11, adopted: 1, create: 1, rewrite: 1 },
      filesWithoutRow: 1,
      dirIndexFiles: 1,
      trashFilesWithoutRow: 1,
      binsWithoutNote: 1,
      tempFiles: 1,
      conflicts: 3,
      filesThatChangeBytes: 2,
    })
    expect(report.sizes.bodyBytes).toBeGreaterThan(0)
    expect(report.sizes.crdtBytes).toBeGreaterThan(0)
    expect(report.sizes.noteRevisionsBytes).toBeGreaterThan(0)
    expect(report.estimate).toMatchObject({ notes: NAMES.length, filesThatChangeBytes: 2 })
    expect(report.estimate.method).toMatch(/N × t_note/)
  })
})

describe('migrate-store CLI', () => {
  const run = (args: string[]) =>
    promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/scripts/migrate-store.ts', ...args], {
      cwd: join(import.meta.dirname, '..'),
      env: process.env,
    })

  it('writes only the report it is given', async () => {
    const out = await mkdtemp(join(tmpdir(), 'migrate-store-'))
    try {
      const before = await snapshot()
      const reportPath = join(out, 'report.json')
      const { stdout } = await run(['--dry-run', '--vault', vaultId, '--report', reportPath])
      expect(stdout).toMatch(/^dry run: 14 notes/)
      expect(JSON.parse(await readFile(reportPath, 'utf8'))).toMatchObject({
        kind: 'adr-003-store-migration-dry-run',
        counts: { notes: NAMES.length, conflicts: 3 },
      })
      expect(await readdir(out)).toEqual(['report.json'])
      expect(await snapshot()).toEqual(before)
      // never overwrites an existing file
      await expect(run(['--dry-run', '--vault', vaultId, '--report', reportPath])).rejects.toThrow(/EEXIST/)
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  })

  it('refuses to run without --dry-run (the backfill ships with S2a)', async () => {
    await expect(run(['--vault', vaultId])).rejects.toMatchObject({ code: 2, stderr: expect.stringMatching(/only --dry-run/) })
  })
})
