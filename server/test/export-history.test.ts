import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import AdmZip from 'adm-zip'
import type { FastifyInstance } from 'fastify'
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { noteRevisions, notes, type users } from '../src/db/schema.js'
import { createNote, saveAsset, softDeleteNote, updateNote } from '../src/notes/store.js'
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

async function importArchive(archive: Buffer, cookie: string): Promise<ImportResult> {
  const boundary = '----historyboundary'
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="export.zip"\r\ncontent-type: application/zip\r\n\r\n`,
    ),
    archive,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  const res = await app.inject({
    method: 'POST',
    url: '/api/import',
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  })
  expect(res.statusCode).toBe(200)
  const result: ImportResult = res.json()
  return result
}

async function exportVault(): Promise<Buffer> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/vaults/${vaultId}/export`,
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
})
