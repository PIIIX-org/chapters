import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import AdmZip from 'adm-zip'
import type { FastifyInstance } from 'fastify'
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { noteRevisions, notes, vaults, type users } from '../src/db/schema.js'
import { createNote, renameNote, revertNote, saveAsset, softDeleteNote, updateNote } from '../src/notes/store.js'
import { createActiveUser, loginCookie } from './helpers.js'

// #499: a vault export carries every revision and the trash, and an import
// recreates both and keeps attachment links pointing at the new vault.

let app: FastifyInstance
let owner: typeof users.$inferSelect
let ownerCookie: string
let vaultId: string
let assetName: string

interface RevisionState {
  action: string
  actorType: string
  actorId: string | null
  body: string
  at: string
}

/** A note's revisions, oldest first, with microsecond creation times. */
async function revisionsOf(noteId: string): Promise<RevisionState[]> {
  return db
    .select({
      action: noteRevisions.action,
      actorType: noteRevisions.actorType,
      actorId: noteRevisions.actorId,
      body: noteRevisions.body,
      at: sql<string>`to_char(${noteRevisions.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(noteRevisions)
    .where(eq(noteRevisions.noteId, noteId))
    .orderBy(asc(noteRevisions.createdAt), asc(noteRevisions.id))
}

async function noteRows(vault: string) {
  return db
    .select({
      id: notes.id,
      path: notes.path,
      body: notes.body,
      deleted: sql<boolean>`${notes.deletedAt} is not null`,
      createdAt: sql<string>`to_char(${notes.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      deletedAt: sql<string | null>`to_char(${notes.deletedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(notes)
    .where(eq(notes.vaultId, vault))
    .orderBy(asc(notes.path), asc(notes.createdAt))
}

interface ImportResult {
  vaultId: string
  imported: number
  skipped: string[]
}

/** `.elara/history/<noteId>.json` as the test reads it. */
interface ExportedHistory {
  path: string
  deletedAt: string | null
  body?: string
  revisions: Array<{ action: string; body: string; createdAt: string; actorType: string; actorEmail?: string }>
}

async function postArchive(archive: Buffer, cookie: string) {
  const boundary = '----historyboundary'
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="export.zip"\r\ncontent-type: application/zip\r\n\r\n`,
    ),
    archive,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return app.inject({
    method: 'POST',
    url: '/api/import',
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  })
}

async function importArchive(archive: Buffer, cookie: string): Promise<ImportResult> {
  const res = await postArchive(archive, cookie)
  expect(res.statusCode).toBe(200)
  const result: ImportResult = res.json()
  return result
}

async function ownedVaultCount(): Promise<number> {
  const rows = await db.select({ id: vaults.id }).from(vaults).where(eq(vaults.ownerId, owner.id))
  return rows.length
}

async function exportVault(vault = vaultId): Promise<Buffer> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/vaults/${vault}/export`,
    headers: { cookie: ownerCookie },
  })
  expect(res.statusCode).toBe(200)
  return res.rawPayload
}

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  owner = await createActiveUser()
  ownerCookie = await loginCookie(app, owner.email)
  const created: { id: string } = (
    await app.inject({
      method: 'POST',
      url: '/api/vaults',
      headers: { cookie: ownerCookie },
      body: { name: 'History vault' },
    })
  ).json()
  vaultId = created.id
  const actor = { type: 'user' as const, id: owner.id }
  assetName = (await saveAsset(vaultId, 'diagram.png', Buffer.from('png bytes'))).fileName
  await createNote(vaultId, { path: 'concepts/revised', body: 'v1\n' }, actor)
  await updateNote(vaultId, 'concepts/revised', { body: 'v2\n' }, actor)
  await updateNote(
    vaultId,
    'concepts/revised',
    { body: `v3 ![diagram](/api/vaults/${vaultId}/assets/${assetName})\n` },
    actor,
  )
  await createNote(vaultId, { path: 'concepts/gone', body: 'goes to trash\n' }, actor)
  await softDeleteNote(vaultId, 'concepts/gone', actor)
  // A path trashed and then recreated: both incarnations must survive.
  await createNote(vaultId, { path: 'concepts/twice', body: 'first incarnation\n' }, actor)
  await softDeleteNote(vaultId, 'concepts/twice', actor)
  await createNote(vaultId, { path: 'concepts/twice', body: 'second incarnation\n' }, actor)
})

afterAll(async () => app.close())

describe('vault export/import keeps history (#499)', () => {
  it('the export carries every revision and every trashed note', async () => {
    const zip = new AdmZip(await exportVault())
    const source = await noteRows(vaultId)
    const names = zip.getEntries().map((e) => e.entryName)
    for (const row of source) {
      const entry = zip.getEntry(`.elara/history/${row.id}.json`)
      expect(entry, row.path).toBeTruthy()
      const history: ExportedHistory = JSON.parse(entry!.getData().toString('utf8'))
      expect(history.path).toBe(row.path)
      expect(history.deletedAt).toBe(row.deletedAt)
      if (row.deleted) expect(history.body).toBe(row.body)
      const want = await revisionsOf(row.id)
      expect(history.revisions.map((r) => [r.action, r.body, r.createdAt])).toEqual(
        want.map((r) => [r.action, r.body, r.at]),
      )
      expect(history.revisions.every((r) => r.actorType === 'user' && r.actorEmail === owner.email)).toBe(true)
    }
    // Trashed notes travel as history, never as OKF note files.
    expect(names.filter((n) => n.endsWith('.md')).sort()).toEqual(['concepts/revised.md', 'concepts/twice.md'])
    const manifest: { vaultId?: string } = JSON.parse(zip.getEntry('manifest.json')!.getData().toString('utf8'))
    expect(manifest.vaultId).toBe(vaultId)
  })

  it('import recreates revisions (order, times, bodies) and the trash under new ids', async () => {
    const result = await importArchive(await exportVault(), ownerCookie)
    expect(result.skipped).toEqual([])
    expect(result.imported).toBe(2)
    const source = await noteRows(vaultId)
    const imported = await noteRows(result.vaultId)
    const rewrite = (s: string) => s.replaceAll(`/api/vaults/${vaultId}/`, `/api/vaults/${result.vaultId}/`)
    expect(imported.map((r) => [r.path, r.deleted, r.createdAt, r.deletedAt, r.body])).toEqual(
      source.map((r) => [r.path, r.deleted, r.createdAt, r.deletedAt, rewrite(r.body)]),
    )
    expect(imported.some((r) => source.some((s) => s.id === r.id))).toBe(false)
    for (const [i, row] of imported.entries()) {
      const want = await revisionsOf(source[i]!.id)
      const got = await revisionsOf(row.id)
      // The importer is the author of the source revisions, so attribution is kept.
      expect(got).toEqual(want.map((r) => ({ ...r, body: rewrite(r.body) })))
    }
    const trash = await db
      .select({ id: notes.id })
      .from(notes)
      .where(and(eq(notes.vaultId, result.vaultId), isNotNull(notes.deletedAt)))
    expect(trash).toHaveLength(2)
  })

  it('import keeps attachment names and points links at the new vault', async () => {
    const result = await importArchive(await exportVault(), ownerCookie)
    const [revised] = await db
      .select({ body: notes.body })
      .from(notes)
      .where(and(eq(notes.vaultId, result.vaultId), eq(notes.path, 'concepts/revised'), isNull(notes.deletedAt)))
    const link = `/api/vaults/${result.vaultId}/assets/${assetName}`
    expect(revised!.body).toContain(link)
    expect(revised!.body).not.toContain(vaultId)
    const download = await app.inject({ method: 'GET', url: link, headers: { cookie: ownerCookie } })
    expect(download.statusCode).toBe(200)
    expect(download.rawPayload.toString()).toBe('png bytes')
  })

  it('revision authors other than the importer are not attributed to local accounts', async () => {
    const other = await createActiveUser()
    const otherCookie = await loginCookie(app, other.email)
    const result = await importArchive(await exportVault(), otherCookie)
    const imported = await noteRows(result.vaultId)
    for (const row of imported) {
      const revs = await revisionsOf(row.id)
      expect(revs.length).toBeGreaterThan(0)
      expect(revs.every((r) => r.actorType === 'user' && r.actorId === null)).toBe(true)
    }
  })

  it('an archive without history (older exports) still imports its live notes', async () => {
    const zip = new AdmZip(await exportVault())
    for (const entry of zip.getEntries()) {
      if (entry.entryName.startsWith('.elara/')) zip.deleteFile(entry.entryName)
    }
    const manifest: Record<string, unknown> = JSON.parse(zip.getEntry('manifest.json')!.getData().toString('utf8'))
    delete manifest.vaultId
    zip.updateFile('manifest.json', Buffer.from(JSON.stringify(manifest), 'utf8'))
    const result = await importArchive(zip.toBuffer(), ownerCookie)
    expect(result.imported).toBe(2)
    const imported = await noteRows(result.vaultId)
    expect(imported.map((r) => [r.path, r.deleted])).toEqual([
      ['concepts/revised', false],
      ['concepts/twice', false],
    ])
    const revised = imported.find((r) => r.path === 'concepts/revised')!
    expect(revised.body).toContain(`/api/vaults/${result.vaultId}/assets/${assetName}`)
    expect(await revisionsOf(revised.id)).toHaveLength(1)
  })

  it('an attachment named *.md stays an attachment, never a note', async () => {
    const zip = new AdmZip(await exportVault())
    // `saveAsset` keeps any extension, so an uploaded readme.md travels as assets/readme-<ms>-<id>.md.
    zip.addFile('assets/readme-1-abc123.md', Buffer.from('plain text, no frontmatter\n', 'utf8'))
    zip.addFile('assets/typed-1-def456.md', Buffer.from('---\ntitle: looks like a note\n---\nbody\n', 'utf8'))
    const result = await importArchive(zip.toBuffer(), ownerCookie)
    expect(result.skipped).toEqual([])
    expect(result.imported).toBe(2)
    const imported = await noteRows(result.vaultId)
    expect(imported.filter((r) => r.path.startsWith('assets/')).map((r) => r.path)).toEqual([])
    const download = await app.inject({
      method: 'GET',
      url: `/api/vaults/${result.vaultId}/assets/readme-1-abc123.md`,
      headers: { cookie: ownerCookie },
    })
    expect(download.statusCode).toBe(200)
    expect(download.rawPayload.toString()).toBe('plain text, no frontmatter\n')
  })

  it('a history time that is no real instant refuses the archive before a vault is created', async () => {
    const zip = new AdmZip(await exportVault())
    const entry = zip.getEntries().find((e) => e.entryName.startsWith('.elara/history/'))!
    const history: ExportedHistory = JSON.parse(entry.getData().toString('utf8'))
    history.revisions[0]!.createdAt = '2024-02-30T25:00:00.000000Z'
    zip.updateFile(entry.entryName, Buffer.from(JSON.stringify(history), 'utf8'))
    const vaultsBefore = await ownedVaultCount()
    const res = await postArchive(zip.toBuffer(), ownerCookie)
    expect(res.statusCode).toBe(400)
    expect(res.json<{ error: string }>().error).toContain('invalid time')
    expect(await ownedVaultCount()).toBe(vaultsBefore)
  })

  it('an asset named "." is dropped instead of failing the import', async () => {
    const zip = new AdmZip(await exportVault())
    // adm-zip normalizes `assets/.` away, so write a same-length name and patch its bytes.
    zip.addFile('assets/~', Buffer.from('not a directory', 'utf8'))
    const crafted = Buffer.from(zip.toBuffer().toString('latin1').replaceAll('assets/~', 'assets/.'), 'latin1')
    expect(new AdmZip(crafted).getEntries().some((e) => e.entryName === 'assets/.')).toBe(true)
    const result = await importArchive(crafted, ownerCookie)
    expect(result.imported).toBe(2)
  })

  it('the manifest carries a format version and a newer one is refused', async () => {
    const zip = new AdmZip(await exportVault())
    const manifest: Record<string, unknown> = JSON.parse(zip.getEntry('manifest.json')!.getData().toString('utf8'))
    expect(manifest.formatVersion).toBe(1)
    zip.updateFile('manifest.json', Buffer.from(JSON.stringify({ ...manifest, formatVersion: 2 }), 'utf8'))
    const vaultsBefore = await ownedVaultCount()
    const res = await postArchive(zip.toBuffer(), ownerCookie)
    expect(res.statusCode).toBe(400)
    expect(await ownedVaultCount()).toBe(vaultsBefore)
  })

  it('rename and revert events keep their paths and source through export and import (#479)', async () => {
    const events: { id: string } = (
      await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie: ownerCookie }, body: { name: 'Events vault' } })
    ).json()
    const actor = { type: 'user' as const, id: owner.id }
    await createNote(events.id, { path: 'concepts/before', body: 'first\n' }, actor)
    await updateNote(events.id, 'concepts/before', { body: 'second\n' }, actor)
    await renameNote(events.id, 'concepts/before', 'after', actor)
    const [created] = await db.select().from(noteRevisions).innerJoin(notes, eq(notes.id, noteRevisions.noteId)).where(
      and(eq(notes.vaultId, events.id), eq(noteRevisions.action, 'create')),
    )
    await revertNote(events.id, 'concepts/after', created!.note_revisions.id, actor)

    type EventRow = { id: string; action: string; fromPath: string | null; toPath: string | null; sourceRevisionId: string | null }
    const eventRows = async (vault: string): Promise<EventRow[]> =>
      (
        await db
          .select({
            id: noteRevisions.id,
            action: noteRevisions.action,
            fromPath: noteRevisions.fromPath,
            toPath: noteRevisions.toPath,
            sourceRevisionId: noteRevisions.sourceRevisionId,
          })
          .from(noteRevisions)
          .innerJoin(notes, eq(notes.id, noteRevisions.noteId))
          .where(eq(notes.vaultId, vault))
          .orderBy(asc(noteRevisions.createdAt), asc(noteRevisions.id))
      )
    const shape = (rows: EventRow[]) =>
      rows.map((r) => [r.action, r.fromPath, r.toPath, r.sourceRevisionId === null ? null : rows.findIndex((s) => s.id === r.sourceRevisionId)])
    const source = await eventRows(events.id)
    expect(shape(source)).toEqual([
      ['create', null, null, null],
      ['update', null, null, null],
      ['rename', 'concepts/before', 'concepts/after', null],
      ['revert', null, null, 0],
    ])

    const archive = await exportVault(events.id)
    const result = await importArchive(archive, ownerCookie)
    const imported = await eventRows(result.vaultId)
    // Same events, and the revert names the imported `create`, not the source vault's.
    expect(shape(imported)).toEqual(shape(source))
    expect(imported.some((r) => source.some((s) => s.id === r.id))).toBe(false)

    // An archive without revision ids (exported before #479) still imports; a revert's source is then unknown.
    const zip = new AdmZip(archive)
    for (const entry of zip.getEntries()) {
      if (!entry.entryName.startsWith('.elara/history/')) continue
      const history: { revisions: Array<Record<string, unknown>> } = JSON.parse(entry.getData().toString('utf8'))
      for (const r of history.revisions) delete r.id
      zip.updateFile(entry.entryName, Buffer.from(JSON.stringify(history), 'utf8'))
    }
    const legacy = await eventRows((await importArchive(zip.toBuffer(), ownerCookie)).vaultId)
    expect(shape(legacy).map((r) => r[3])).toEqual([null, null, null, null])
    expect(shape(legacy)[2]).toEqual(['rename', 'concepts/before', 'concepts/after', null])
  })
})
