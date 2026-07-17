import { mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { noteLinks, notes } from '../db/schema.js'
import { config } from '../config.js'
import { scheduleEmbedding } from '../search/embedding-queue.js'
import {
  OkfValidationError,
  extractWikilinks,
  parseNote,
  serializeNote,
  validateNote,
  isSlug,
  type Frontmatter,
} from './okf.js'

export type NoteRow = typeof notes.$inferSelect

function vaultDir(vaultId: string): string {
  return join(config.dataDir, 'vaults', vaultId)
}

function noteFile(vaultId: string, path: string): string {
  return join(vaultDir(vaultId), `${path}.md`)
}

function trashFile(vaultId: string, noteId: string): string {
  return join(vaultDir(vaultId), '.trash', `${noteId}.md`)
}

/** Drizzle wraps driver errors; the Postgres code may sit on `cause`. */
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err
  while (current instanceof Error) {
    if ((current as { code?: string }).code === '23505') return true
    current = current.cause
  }
  return false
}

export function splitPath(path: string): { type: string; name: string } {
  const parts = path.split('/')
  if (parts.length !== 2 || !isSlug(parts[0]!) || !isSlug(parts[1]!)) {
    throw new OkfValidationError(`invalid note path: ${path}`)
  }
  return { type: parts[0]!, name: parts[1]! }
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, file)
}

/**
 * OKF convention: every type folder carries an auto-generated index.md
 * listing its notes. Derived output — regenerated on any change, never
 * indexed as a note itself.
 */
async function regenIndex(vaultId: string, type: string): Promise<void> {
  const rows = await db
    .select({ path: notes.path, name: notes.name })
    .from(notes)
    .where(and(eq(notes.vaultId, vaultId), eq(notes.type, type), isNull(notes.deletedAt)))
    .orderBy(asc(notes.name))
  const file = join(vaultDir(vaultId), type, 'index.md')
  if (rows.length === 0) {
    await unlink(file).catch(() => {})
    return
  }
  const lines = rows.map((r) => `- [[${r.path}]]`)
  await atomicWrite(file, `# ${type}\n\n${lines.join('\n')}\n`)
}

export async function createNote(
  vaultId: string,
  input: { type: string; name: string; frontmatter?: Record<string, unknown>; body?: string },
): Promise<NoteRow> {
  const frontmatter: Frontmatter = {
    timestamp: new Date().toISOString(),
    ...input.frontmatter,
    type: input.type,
  }
  const body = input.body ?? ''
  validateNote(input.type, input.name, frontmatter, body)
  const path = `${input.type}/${input.name}`
  let row: NoteRow
  try {
    const inserted = await db
      .insert(notes)
      .values({ vaultId, type: input.type, name: input.name, path, frontmatter, body })
      .returning()
    row = inserted[0]!
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new OkfValidationError(`a note already exists at ${path}`)
    }
    throw err
  }
  await atomicWrite(noteFile(vaultId, path), serializeNote({ frontmatter, body }))
  await regenIndex(vaultId, input.type)
  await syncLinks(row.id, body)
  scheduleEmbedding(row.id)
  return row
}

/** Replaces the note's EXTRACTED link rows from its current wikilinks. */
export async function syncNoteLinks(noteId: string, body: string): Promise<void> {
  return syncLinks(noteId, body)
}

async function syncLinks(noteId: string, body: string): Promise<void> {
  await db.delete(noteLinks).where(eq(noteLinks.sourceNoteId, noteId))
  const targets = extractWikilinks(body)
  if (targets.length > 0) {
    await db
      .insert(noteLinks)
      .values(targets.map((targetPath) => ({ sourceNoteId: noteId, targetPath })))
      .onConflictDoNothing()
  }
}

export async function getLiveNote(vaultId: string, path: string): Promise<NoteRow | null> {
  const rows = await db
    .select()
    .from(notes)
    .where(and(eq(notes.vaultId, vaultId), eq(notes.path, path), isNull(notes.deletedAt)))
  return rows[0] ?? null
}

/** Reads a note's current content from disk (canonical source). */
export async function readNote(
  vaultId: string,
  path: string,
): Promise<{ row: NoteRow; frontmatter: Frontmatter; body: string } | null> {
  const row = await getLiveNote(vaultId, path)
  if (!row) return null
  const raw = await readFile(noteFile(vaultId, path), 'utf8')
  const parsed = parseNote(raw)
  return { row, frontmatter: parsed.frontmatter, body: parsed.body }
}

export async function updateNote(
  vaultId: string,
  path: string,
  input: { frontmatter?: Record<string, unknown>; body?: string },
): Promise<NoteRow | null> {
  const row = await getLiveNote(vaultId, path)
  if (!row) return null
  const frontmatter: Frontmatter = {
    ...(input.frontmatter ?? (row.frontmatter as Frontmatter)),
    type: row.type,
  }
  const body = input.body ?? row.body
  validateNote(row.type, row.name, frontmatter, body)
  const [updated] = await db
    .update(notes)
    .set({ frontmatter, body, updatedAt: new Date() })
    .where(eq(notes.id, row.id))
    .returning()
  await atomicWrite(noteFile(vaultId, path), serializeNote({ frontmatter, body }))
  await syncLinks(row.id, body)
  scheduleEmbedding(row.id)
  return updated!
}

export async function renameNote(
  vaultId: string,
  from: string,
  toName: string,
): Promise<NoteRow | null> {
  const row = await getLiveNote(vaultId, from)
  if (!row) return null
  if (!isSlug(toName)) throw new OkfValidationError(`invalid name slug: ${toName}`)
  const toPath = `${row.type}/${toName}`
  if (await getLiveNote(vaultId, toPath)) {
    throw new OkfValidationError(`a note already exists at ${toPath}`)
  }
  const [updated] = await db
    .update(notes)
    .set({ name: toName, path: toPath, updatedAt: new Date() })
    .where(eq(notes.id, row.id))
    .returning()
  await rename(noteFile(vaultId, from), noteFile(vaultId, toPath))
  await regenIndex(vaultId, row.type)
  return updated!
}

/** Soft delete (spec 6: one consistent delete behavior): file → .trash, row keeps everything. */
export async function softDeleteNote(vaultId: string, path: string): Promise<NoteRow | null> {
  const row = await getLiveNote(vaultId, path)
  if (!row) return null
  const [updated] = await db
    .update(notes)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(notes.id, row.id))
    .returning()
  await mkdir(join(vaultDir(vaultId), '.trash'), { recursive: true })
  await rename(noteFile(vaultId, path), trashFile(vaultId, row.id))
  await regenIndex(vaultId, row.type)
  return updated!
}

export async function restoreNote(vaultId: string, noteId: string): Promise<NoteRow | null> {
  const rows = await db
    .select()
    .from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.vaultId, vaultId), isNotNull(notes.deletedAt)))
  const row = rows[0]
  if (!row) return null
  if (await getLiveNote(vaultId, row.path)) {
    throw new OkfValidationError(`a live note already exists at ${row.path}`)
  }
  const [updated] = await db
    .update(notes)
    .set({ deletedAt: null, updatedAt: new Date() })
    .where(eq(notes.id, row.id))
    .returning()
  await mkdir(dirname(noteFile(vaultId, row.path)), { recursive: true })
  await rename(trashFile(vaultId, row.id), noteFile(vaultId, row.path))
  await regenIndex(vaultId, row.type)
  scheduleEmbedding(row.id)
  return updated!
}

export async function listNotes(vaultId: string): Promise<
  Array<Pick<NoteRow, 'id' | 'path' | 'type' | 'name' | 'frontmatter' | 'updatedAt'>>
> {
  return db
    .select({
      id: notes.id,
      path: notes.path,
      type: notes.type,
      name: notes.name,
      frontmatter: notes.frontmatter,
      updatedAt: notes.updatedAt,
    })
    .from(notes)
    .where(and(eq(notes.vaultId, vaultId), isNull(notes.deletedAt)))
    .orderBy(asc(notes.path))
}

export async function listTrash(vaultId: string): Promise<
  Array<Pick<NoteRow, 'id' | 'path' | 'type' | 'name' | 'deletedAt'>>
> {
  return db
    .select({
      id: notes.id,
      path: notes.path,
      type: notes.type,
      name: notes.name,
      deletedAt: notes.deletedAt,
    })
    .from(notes)
    .where(and(eq(notes.vaultId, vaultId), isNotNull(notes.deletedAt)))
}

/** Permanently removes a trashed note (used by purge policies later). */
export async function purgeNote(vaultId: string, noteId: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.vaultId, vaultId), isNotNull(notes.deletedAt)))
  const row = rows[0]
  if (!row) return false
  await db.delete(notes).where(eq(notes.id, row.id))
  await rm(trashFile(vaultId, row.id), { force: true })
  return true
}
