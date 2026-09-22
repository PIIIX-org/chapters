import { mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { and, asc, desc, eq, isNotNull, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { noteLinks, noteRevisions, notes } from '../db/schema.js'
import { config } from '../config.js'
import { scheduleEmbedding } from '../search/embedding-queue.js'
import { deleteSemanticEdgesFor } from '../search/semantic-edges.js'
import {
  OkfValidationError,
  extractWikilinks,
  parseNote,
  serializeNote,
  validateNote,
  isSlug,
  type Frontmatter,
} from './okf.js'
import {
  resolveNotePath,
  type ResolvedNotePath,
  splitPath,
} from './okf/paths.js'

export { splitPath, resolveNotePath, type ResolvedNotePath }

export type NoteRow = typeof notes.$inferSelect
export type RevisionRow = typeof noteRevisions.$inferSelect

/** Who performed a write — recorded in the audit trail (spec 6). */
export interface Actor {
  type: 'user' | 'mcp' | 'collab'
  id?: string
}

const SYSTEM_ACTOR: Actor = { type: 'collab' }

/** Records a revision unless identical to the note's latest one (dedupes
 * the MCP-immediate + collab-debounced double-write of the same state). */
async function recordRevision(
  noteId: string,
  action: string,
  frontmatter: unknown,
  body: string,
  actor: Actor,
): Promise<void> {
  const last = (
    await db
      .select({ frontmatter: noteRevisions.frontmatter, body: noteRevisions.body })
      .from(noteRevisions)
      .where(eq(noteRevisions.noteId, noteId))
      .orderBy(desc(noteRevisions.createdAt))
      .limit(1)
  )[0]
  if (last && last.body === body && JSON.stringify(last.frontmatter) === JSON.stringify(frontmatter)) {
    return
  }
  await db.insert(noteRevisions).values({
    noteId,
    actorType: actor.type,
    actorId: actor.id,
    action,
    frontmatter: frontmatter as Record<string, unknown>,
    body,
  })
}

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

async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, file)
}

/**
 * OKF v0.2 Progressive Disclosure: regenerates index.md for each directory in ancestorDirs.
 * Contains subsystems (child directories) and concepts & artifacts (direct child notes).
 * If a directory has 0 notes and 0 subdirectories, index.md is unlinked.
 */
export async function regenProgressiveIndices(
  vaultId: string,
  ancestorDirs: string[],
): Promise<void> {
  const uniqueDirs = [...new Set(ancestorDirs.filter(Boolean))]
  if (uniqueDirs.length === 0) return

  const rows = await db
    .select({
      path: notes.path,
      type: notes.type,
      name: notes.name,
      frontmatter: notes.frontmatter,
    })
    .from(notes)
    .where(and(eq(notes.vaultId, vaultId), isNull(notes.deletedAt)))

  for (const dir of uniqueDirs) {
    const prefix = `${dir}/`
    const subdirCounts = new Map<string, number>()
    const childNotes: Array<{
      path: string
      baseName: string
      type: string
      frontmatter: Record<string, unknown>
    }> = []

    for (const note of rows) {
      if (note.path === 'index' || note.path.endsWith('/index')) continue
      if (!note.path.startsWith(prefix)) continue

      const remainder = note.path.slice(prefix.length)
      if (!remainder) continue

      const slashIndex = remainder.indexOf('/')
      if (slashIndex === -1) {
        childNotes.push({
          path: note.path,
          baseName: remainder,
          type: note.type,
          frontmatter: (note.frontmatter ?? {}) as Record<string, unknown>,
        })
      } else {
        const subdir = remainder.slice(0, slashIndex)
        subdirCounts.set(subdir, (subdirCounts.get(subdir) ?? 0) + 1)
      }
    }

    const file = join(vaultDir(vaultId), dir, 'index.md')

    if (subdirCounts.size === 0 && childNotes.length === 0) {
      await unlink(file).catch(() => {})
      continue
    }

    const sections: string[] = []

    if (subdirCounts.size > 0) {
      const sortedSubdirs = [...subdirCounts.entries()].sort(([a], [b]) => a.localeCompare(b))
      const lines = [
        '## Subsystems & Architectural Domains',
        '',
        '| Subsystem / Domain | Active Concepts | Index |',
        '| :--- | :--- | :--- |',
      ]
      for (const [subdir, count] of sortedSubdirs) {
        lines.push(`| **${subdir}** | ${count} notes | [[${dir}/${subdir}/index|View Domain]] |`)
      }
      sections.push(lines.join('\n'))
    }

    if (childNotes.length > 0) {
      childNotes.sort((a, b) => a.path.localeCompare(b.path))
      const lines = [
        '## Concepts & Artifacts',
        '',
        '| Concept | Type | Status | Description |',
        '| :--- | :--- | :--- | :--- |',
      ]
      for (const child of childNotes) {
        const fm = child.frontmatter
        const type = typeof fm.type === 'string' && fm.type ? String(fm.type) : child.type
        const status = fm.status !== undefined && fm.status !== null ? String(fm.status) : ''
        const description = typeof fm.description === 'string' ? fm.description : ''
        const link =
          typeof fm.title === 'string' && fm.title.trim() && fm.title.trim() !== child.baseName
            ? `[[${child.path}|${fm.title.trim()}]]`
            : `[[${child.path}]]`
        lines.push(`| ${link} | \`${type}\` | ${status} | ${description} |`)
      }
      sections.push(lines.join('\n'))
    }

    await atomicWrite(file, `${sections.join('\n\n')}\n`)
  }
}

export async function createNote(
  vaultId: string,
  input: {
    path?: string
    type?: string
    name?: string
    frontmatter?: Record<string, unknown>
    body?: string
  },
  actor: Actor = SYSTEM_ACTOR,
): Promise<NoteRow> {
  const rawPath =
    input.path ??
    (input.type && input.name
      ? `${input.type}/${input.name}`
      : `${input.type ?? ''}/${input.name ?? ''}`)
  const resolved = resolveNotePath(rawPath)
  const frontmatter: Frontmatter = {
    timestamp: new Date().toISOString(),
    ...input.frontmatter,
    type: input.frontmatter?.type ? String(input.frontmatter.type) : resolved.type,
  }
  const body = input.body ?? ''
  validateNote(resolved.type, resolved.name, frontmatter, body)
  let row: NoteRow
  try {
    const inserted = await db
      .insert(notes)
      .values({
        vaultId,
        type: resolved.type,
        name: resolved.name,
        path: resolved.fullPath,
        frontmatter,
        body,
      })
      .returning()
    row = inserted[0]!
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new OkfValidationError(`a note already exists at ${resolved.fullPath}`)
    }
    throw err
  }
  await atomicWrite(noteFile(vaultId, resolved.fullPath), serializeNote({ frontmatter, body }))
  await regenProgressiveIndices(vaultId, resolved.ancestorDirectories)
  await syncLinks(row.id, body)
  scheduleEmbedding(row.id)
  await recordRevision(row.id, 'create', frontmatter, body, actor)
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
  const resolved = resolveNotePath(path)
  const rows = await db
    .select()
    .from(notes)
    .where(and(eq(notes.vaultId, vaultId), eq(notes.path, resolved.fullPath), isNull(notes.deletedAt)))
  return rows[0] ?? null
}

/**
 * Reads a note's current content from disk (canonical source), falling back
 * to the row when the file is gone. createNote inserts the row before it
 * writes the file, so a crash in between leaves a live note with no file —
 * permanently. Every read path (note view, export, backup, collab, MCP) used
 * to throw ENOENT on such a note; the instance backup, which walks every
 * vault, then failed entirely because of one note. The row mirrors the file
 * on every write, so it is the right recovery. Only ENOENT falls back: real
 * disk faults still surface.
 */
export async function readNote(
  vaultId: string,
  path: string,
): Promise<{ row: NoteRow; frontmatter: Frontmatter; body: string } | null> {
  const resolved = resolveNotePath(path)
  const row = await getLiveNote(vaultId, resolved.fullPath)
  if (!row) return null
  let raw: string
  try {
    raw = await readFile(noteFile(vaultId, resolved.fullPath), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    return { row, frontmatter: row.frontmatter as Frontmatter, body: row.body }
  }
  const parsed = parseNote(raw)
  return { row, frontmatter: parsed.frontmatter, body: parsed.body }
}

export async function updateNote(
  vaultId: string,
  path: string,
  input: { frontmatter?: Record<string, unknown>; body?: string },
  actor: Actor = SYSTEM_ACTOR,
): Promise<NoteRow | null> {
  const resolved = resolveNotePath(path)
  const row = await getLiveNote(vaultId, resolved.fullPath)
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
  await atomicWrite(noteFile(vaultId, resolved.fullPath), serializeNote({ frontmatter, body }))
  await regenProgressiveIndices(vaultId, resolved.ancestorDirectories)
  await syncLinks(row.id, body)
  scheduleEmbedding(row.id)
  await recordRevision(row.id, 'update', frontmatter, body, actor)
  return updated!
}

export async function renameNote(
  vaultId: string,
  from: string,
  toName: string,
): Promise<NoteRow | null> {
  const fromResolved = resolveNotePath(from)
  const row = await getLiveNote(vaultId, fromResolved.fullPath)
  if (!row) return null
  let toPath: string
  if (isSlug(toName)) {
    toPath = fromResolved.directory ? `${fromResolved.directory}/${toName}` : toName
  } else {
    toPath = toName
  }
  const toResolved = resolveNotePath(toPath)
  if (await getLiveNote(vaultId, toResolved.fullPath)) {
    throw new OkfValidationError(`a note already exists at ${toResolved.fullPath}`)
  }
  const [updated] = await db
    .update(notes)
    .set({
      name: toResolved.name,
      type: toResolved.type,
      path: toResolved.fullPath,
      updatedAt: new Date(),
    })
    .where(eq(notes.id, row.id))
    .returning()
  await mkdir(dirname(noteFile(vaultId, toResolved.fullPath)), { recursive: true })
  await rename(noteFile(vaultId, fromResolved.fullPath), noteFile(vaultId, toResolved.fullPath))
  const affectedDirs = [
    ...new Set([...fromResolved.ancestorDirectories, ...toResolved.ancestorDirectories]),
  ]
  await regenProgressiveIndices(vaultId, affectedDirs)
  return updated!
}

/** Soft delete (spec 6: one consistent delete behavior): file → .trash, row keeps everything. */
export async function softDeleteNote(
  vaultId: string,
  path: string,
  actor: Actor = SYSTEM_ACTOR,
): Promise<NoteRow | null> {
  const resolved = resolveNotePath(path)
  const row = await getLiveNote(vaultId, resolved.fullPath)
  if (!row) return null
  const [updated] = await db
    .update(notes)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(notes.id, row.id))
    .returning()
  await mkdir(join(vaultDir(vaultId), '.trash'), { recursive: true })
  await rename(noteFile(vaultId, resolved.fullPath), trashFile(vaultId, row.id))
  await regenProgressiveIndices(vaultId, resolved.ancestorDirectories)
  await recordRevision(row.id, 'delete', row.frontmatter, row.body, actor)
  return updated!
}

export async function restoreNote(vaultId: string, noteId: string): Promise<NoteRow | null> {
  const rows = await db
    .select()
    .from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.vaultId, vaultId), isNotNull(notes.deletedAt)))
  const row = rows[0]
  if (!row) return null
  const resolved = resolveNotePath(row.path)
  if (await getLiveNote(vaultId, resolved.fullPath)) {
    throw new OkfValidationError(`a live note already exists at ${resolved.fullPath}`)
  }
  const [updated] = await db
    .update(notes)
    .set({ deletedAt: null, updatedAt: new Date() })
    .where(eq(notes.id, row.id))
    .returning()
  await mkdir(dirname(noteFile(vaultId, resolved.fullPath)), { recursive: true })
  await rename(trashFile(vaultId, row.id), noteFile(vaultId, resolved.fullPath))
  await regenProgressiveIndices(vaultId, resolved.ancestorDirectories)
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

export async function listTrash(
  vaultId: string,
  limit = 50,
  offset = 0,
): Promise<Array<Pick<NoteRow, 'id' | 'path' | 'type' | 'name' | 'deletedAt'>>> {
  // Paginated for the same reason history is (rule 3, no unbounded reads): a
  // vault that has been in use for years accumulates trash without limit, and
  // this unit is the first thing that ever reads it.
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
    .orderBy(desc(notes.deletedAt))
    .limit(limit)
    .offset(offset)
}

/** Change history for a note, newest first (edit/owner only — enforced by callers). */
export async function listRevisions(
  vaultId: string,
  path: string,
): Promise<RevisionRow[] | null> {
  const row = await getLiveNote(vaultId, path)
  if (!row) return null
  return db
    .select()
    .from(noteRevisions)
    .where(eq(noteRevisions.noteId, row.id))
    .orderBy(desc(noteRevisions.createdAt))
}

export type RevisionMeta = Pick<RevisionRow, 'id' | 'actorType' | 'actorId' | 'action' | 'createdAt'>

/** Revision metadata only — never a note's content — newest first, always
 * bounded (perf rule 3: no unbounded reads). `listRevisions` still returns the
 * full payload for the MCP note_history tool. */
export async function listRevisionMeta(
  vaultId: string,
  path: string,
  limit: number,
  offset: number,
): Promise<RevisionMeta[] | null> {
  const row = await getLiveNote(vaultId, path)
  if (!row) return null
  return db
    .select({
      id: noteRevisions.id,
      actorType: noteRevisions.actorType,
      actorId: noteRevisions.actorId,
      action: noteRevisions.action,
      createdAt: noteRevisions.createdAt,
    })
    .from(noteRevisions)
    .where(eq(noteRevisions.noteId, row.id))
    .orderBy(desc(noteRevisions.createdAt))
    .limit(limit)
    .offset(offset)
}

/** Restores a note to a recorded revision (a new attributed write). */
export async function revertNote(
  vaultId: string,
  path: string,
  revisionId: string,
  actor: Actor,
): Promise<NoteRow | null> {
  const row = await getLiveNote(vaultId, path)
  if (!row) return null
  const revision = (
    await db
      .select()
      .from(noteRevisions)
      .where(and(eq(noteRevisions.id, revisionId), eq(noteRevisions.noteId, row.id)))
  )[0]
  if (!revision) return null
  const updated = await updateNote(
    vaultId,
    path,
    { frontmatter: revision.frontmatter as Record<string, unknown>, body: revision.body },
    actor,
  )
  if (updated) {
    const newest = (
      await db
        .select({ id: noteRevisions.id })
        .from(noteRevisions)
        .where(eq(noteRevisions.noteId, row.id))
        .orderBy(desc(noteRevisions.createdAt))
        .limit(1)
    )[0]
    if (newest) {
      await db
        .update(noteRevisions)
        .set({ action: 'revert' })
        .where(eq(noteRevisions.id, newest.id))
    }
  }
  return updated
}

/**
 * Hard purge (spec 6): permanently removes one recorded revision — for
 * accidentally-committed secrets, where "recoverable" is the wrong
 * property. Owner/admin only — enforced by callers.
 */
export async function purgeRevision(vaultId: string, revisionId: string): Promise<boolean> {
  const rows = await db
    .select({ revisionId: noteRevisions.id })
    .from(noteRevisions)
    .innerJoin(notes, eq(notes.id, noteRevisions.noteId))
    .where(and(eq(noteRevisions.id, revisionId), eq(notes.vaultId, vaultId)))
  if (rows.length === 0) return false
  await db.delete(noteRevisions).where(eq(noteRevisions.id, revisionId))
  return true
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
  // semanticEdges is polymorphic and has no FK (spec 9), so it does not
  // cascade — clear it by hand or the rows leak (#92).
  await deleteSemanticEdgesFor('note', [row.id])
  await rm(trashFile(vaultId, row.id), { force: true })
  return true
}
