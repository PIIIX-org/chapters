import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { mcpConnections, noteLinks, noteRevisions, notes, semanticEdges } from '../db/schema.js'
import { config } from '../config.js'
import { scheduleEmbedding } from '../search/embedding-queue.js'
import { deleteSemanticEdgesFor } from '../search/semantic-edges.js'
import { deleteCrdtState, renameCrdtState } from '../sync/crdt-store.js'
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
import { atomicWrite } from './atomic-write.js'
import { withKeyLock, withKeyLocks } from './key-lock.js'
import { assertBodyFits, NoteTooLargeError } from './size-cap.js'
import { NoteWriteQuarantinedError, suspiciousWrite, type QuarantineRules } from './growth-guard.js'

export { splitPath, resolveNotePath, type ResolvedNotePath }

export type NoteRow = typeof notes.$inferSelect
export type RevisionRow = typeof noteRevisions.$inferSelect

/** Who performed a write — recorded in the audit trail (spec 6). */
export interface Actor {
  type: 'user' | 'mcp' | 'collab'
  id?: string
}

const SYSTEM_ACTOR: Actor = { type: 'collab' }

/** createNote found a live note at the path (the unique index decided, #478). */
export class NoteExistsError extends OkfValidationError {
  constructor(path: string) {
    super(`a note already exists at ${path}`)
  }
}

/** The `note_revisions.action` of a write kept out of the note (#492, notes/growth-guard.ts). */
export const QUARANTINE_ACTION = 'quarantine'

/** The `note_revisions.action` of the state kept before an agent's first write in a session (#482). */
export const RESTORE_POINT_ACTION = 'restore_point'

/** An MCP connection's session on a note ends after this many minutes without a revision of its own there (#482). */
export const RESTORE_POINT_IDLE_MINUTES = 30

/** The revision actions recordRevision dedupes: content writes. */
const DEDUPED_ACTIONS: Record<string, true> = { create: true, update: true }

/** Revisions recordRevision never compares a write with: not a write's state (#482, #492). */
const NOT_A_DEDUPE_BASELINE = [QUARANTINE_ACTION, RESTORE_POINT_ACTION, 'delete']

/** Records a revision unless it repeats the note's latest content. Frontmatter
 * is compared as jsonb stores it (#480): deep equality on its JSON form, so
 * object key order (jsonb uses its own, the collab document and a
 * frontmatter merge keep theirs), `undefined` members and Date vs ISO string
 * never count, while array order and every value still do.
 *
 * An equal state is a repeat only from the same actor (kind and id), or from
 * the relay (`collab`), whose store of an already recorded state changes
 * nothing. An attributed write (`mcp`, `user`) of the state the relay just
 * stored is recorded: the relay's revision has no author (#403) and may
 * bundle a person's typing, so it is never re-attributed.
 *
 * Only content writes (DEDUPED_ACTIONS) are deduped; an event (`delete`) is
 * always recorded. The write is compared with the newest content revision:
 * quarantined writes (#492), restore points (#482) and events are not a
 * write's state, so they are never the baseline. */
async function recordRevision(
  noteId: string,
  action: string,
  frontmatter: unknown,
  body: string,
  actor: Actor,
): Promise<void> {
  if (DEDUPED_ACTIONS[action]) {
    const last = (
      await db
        .select({
          frontmatter: noteRevisions.frontmatter,
          body: noteRevisions.body,
          actorType: noteRevisions.actorType,
          actorId: noteRevisions.actorId,
        })
        .from(noteRevisions)
        .where(and(eq(noteRevisions.noteId, noteId), notInArray(noteRevisions.action, NOT_A_DEDUPE_BASELINE)))
        .orderBy(desc(noteRevisions.createdAt))
        .limit(1)
    )[0]
    const repeatsAuthor = actor.type === 'collab' || (last?.actorType === actor.type && last.actorId === (actor.id ?? null))
    if (
      last &&
      repeatsAuthor &&
      last.body === body &&
      isDeepStrictEqual(last.frontmatter, JSON.parse(JSON.stringify(frontmatter ?? null)))
    ) {
      return
    }
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

/**
 * Runs an MCP connection's write to a note and, when it is the connection's
 * first write to that note in a session (#482), keeps the state the note had
 * just before it as a `restore_point` revision attributed to the connection:
 * one revert to it undoes everything that agent did in the session.
 *
 * MCP is served as stateless HTTP with no session id, so a session is the
 * connection on this note until it has recorded no revision there for
 * RESTORE_POINT_IDLE_MINUTES (quarantined writes do not count: they are not
 * the note's state). The state is read before the write and recorded, dated
 * at that read, only when `write` returns a result: a refused or failed write
 * leaves no restore point. Unlike recordRevision it is kept even when the
 * latest revision holds the same state (someone else's, or the agent's own
 * from an earlier session); only not when that latest revision already is
 * this connection's restore point of this state. The state kept is the stored
 * note: typing the relay has not stored yet is not in it. Writes by the same
 * connection to the note (keyed by note id, so whatever path it is reached
 * by, also across a rename) run one at a time, so concurrent first writes
 * keep one restore point. A restore point that cannot be stored (the note was
 * purged in between) is logged, not reported as the write's failure: the
 * write has landed.
 */
export async function withRestorePoint<T>(
  vaultId: string,
  path: string,
  connectionId: string,
  write: () => Promise<T>,
): Promise<T> {
  const found = await getLiveNote(vaultId, path)
  // No live note: nothing to keep, and the write itself reports the missing note.
  if (!found) return write()
  return withKeyLock(`restore-point:${connectionId}:${found.id}`, async () => {
    const point = await pendingRestorePoint(found.id, connectionId)
    const result = await write()
    if (point && result) {
      try {
        await db.insert(noteRevisions).values(point)
      } catch (err) {
        console.warn(`[restore-point] note ${found.id}: restore point not kept: ${(err as Error).message}`)
      }
    }
    return result
  })
}

/** The restore point withRestorePoint records after the write, or null when the session already has one. */
async function pendingRestorePoint(noteId: string, connectionId: string) {
  // The database's clock, as text, read before the row: a revision committed
  // after the read sorts after the restore point. A JS Date would drop the
  // microseconds that order revisions.
  const [clock] = await db.execute<{ at: string }>(sql`select clock_timestamp()::text as at`)
  const row = (await db.select().from(notes).where(and(eq(notes.id, noteId), isNull(notes.deletedAt))))[0]
  if (!row) return null
  const active = await db
    .select({ id: noteRevisions.id })
    .from(noteRevisions)
    .where(
      and(
        eq(noteRevisions.noteId, row.id),
        eq(noteRevisions.actorType, 'mcp'),
        eq(noteRevisions.actorId, connectionId),
        ne(noteRevisions.action, QUARANTINE_ACTION),
        sql`${noteRevisions.createdAt} > now() - make_interval(mins => ${RESTORE_POINT_IDLE_MINUTES})`,
      ),
    )
    .limit(1)
  if (active.length > 0) return null
  const last = (
    await db
      .select()
      .from(noteRevisions)
      .where(and(eq(noteRevisions.noteId, row.id), ne(noteRevisions.action, QUARANTINE_ACTION)))
      .orderBy(desc(noteRevisions.createdAt))
      .limit(1)
  )[0]
  if (
    last?.action === RESTORE_POINT_ACTION &&
    last.actorType === 'mcp' &&
    last.actorId === connectionId &&
    last.body === row.body &&
    isDeepStrictEqual(last.frontmatter, row.frontmatter)
  ) {
    return null
  }
  return {
    noteId: row.id,
    actorType: 'mcp' as const,
    actorId: connectionId,
    action: RESTORE_POINT_ACTION,
    frontmatter: row.frontmatter as Record<string, unknown>,
    body: row.body,
    createdAt: sql`${clock!.at}::timestamptz`,
  }
}

/**
 * Keeps a suspicious write out of the note (#492): when `input.body` breaks
 * one of `rules` against the stored body, the write is recorded as a
 * `quarantine` revision (the row and the file are not touched) and a
 * NoteWriteQuarantinedError is thrown. A write that continues a quarantine
 * replaces that revision instead of adding one per attempt: for the collab
 * relay, the revision `episode` recorded for the same loaded document (which
 * stays doubled while someone types); for other actors, an identical retry of
 * the quarantine recorded last. A freshly loaded document has no episode, so
 * its quarantine is always a new revision.
 */
export async function refuseSuspiciousWrite(
  row: NoteRow,
  input: { frontmatter?: Record<string, unknown>; body?: string },
  actor: Actor,
  rules: QuarantineRules,
  episode?: string,
): Promise<void> {
  if (input.body === undefined) return
  const finding = suspiciousWrite(row.body, input.body, rules)
  if (!finding) return
  const frontmatter = { ...(input.frontmatter ?? (row.frontmatter as Frontmatter)), type: row.type }
  let continued: string | undefined
  if (actor.type === 'collab') {
    continued = episode
  } else {
    const newest = (
      await db
        .select()
        .from(noteRevisions)
        .where(eq(noteRevisions.noteId, row.id))
        .orderBy(desc(noteRevisions.createdAt))
        .limit(1)
    )[0]
    if (
      newest?.action === QUARANTINE_ACTION &&
      newest.actorType === actor.type &&
      newest.actorId === (actor.id ?? null) &&
      newest.body === input.body
    ) {
      continued = newest.id
    }
  }
  if (continued) {
    const updated = await db
      .update(noteRevisions)
      .set({ frontmatter, body: input.body, createdAt: sql`now()` })
      .where(and(eq(noteRevisions.id, continued), eq(noteRevisions.noteId, row.id), eq(noteRevisions.action, QUARANTINE_ACTION)))
      .returning({ id: noteRevisions.id })
    if (updated.length > 0) throw new NoteWriteQuarantinedError(row.path, finding, continued, true)
  }
  const [inserted] = await db
    .insert(noteRevisions)
    .values({ noteId: row.id, actorType: actor.type, actorId: actor.id, action: QUARANTINE_ACTION, frontmatter, body: input.body })
    .returning({ id: noteRevisions.id })
  throw new NoteWriteQuarantinedError(row.path, finding, inserted!.id, false)
}

export function vaultDir(vaultId: string): string {
  return join(config.dataDir, 'vaults', vaultId)
}

export function noteFile(vaultId: string, path: string): string {
  return join(vaultDir(vaultId), `${path}.md`)
}

export function trashFile(vaultId: string, noteId: string): string {
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

/**
 * The key-lock.ts key held by every writer of the note at `path`: create,
 * update, rename (both paths), delete, restore and purge (#401, #484).
 */
function noteLock(vaultId: string, path: string): string {
  return `note:${vaultId}/${path}`
}

/**
 * OKF v0.2 Progressive Disclosure: regenerates index.md for each directory in ancestorDirs.
 * Contains subsystems (child directories) and concepts & artifacts (direct child notes).
 * If a directory has 0 notes and 0 subdirectories, index.md is unlinked.
 * A directory whose `<dir>/index` is a live note is skipped entirely: that file is the
 * user's note, and the generated table would overwrite or unlink it (#384).
 *
 * Each directory's index is read and written under the `index:<vault>/<dir>` lock, and the
 * note list is read after the locks are held, so concurrent writers into one folder write
 * index.md in turn and the last write lists every note committed before it (#779). Lock
 * order: a caller may hold `note:` locks while calling this (every note writer in this
 * file does); nothing here takes a `note:` lock, so the two never wait on each other in a cycle.
 */
export async function regenProgressiveIndices(
  vaultId: string,
  ancestorDirs: string[],
): Promise<void> {
  const uniqueDirs = [...new Set(ancestorDirs.filter(Boolean))]
  if (uniqueDirs.length === 0) return
  await withKeyLocks(
    uniqueDirs.map((dir) => `index:${vaultId}/${dir}`),
    () => writeProgressiveIndices(vaultId, uniqueDirs),
  )
}

async function writeProgressiveIndices(vaultId: string, uniqueDirs: string[]): Promise<void> {
  const rows = await db
    .select({
      path: notes.path,
      type: notes.type,
      name: notes.name,
      frontmatter: notes.frontmatter,
    })
    .from(notes)
    .where(and(eq(notes.vaultId, vaultId), isNull(notes.deletedAt)))

  const userIndexDirs = new Set(
    rows.filter((note) => note.path.endsWith('/index')).map((note) => note.path.slice(0, -'/index'.length)),
  )

  for (const dir of uniqueDirs) {
    if (userIndexDirs.has(dir)) continue
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
  assertBodyFits(body)
  return withKeyLock(noteLock(vaultId, resolved.fullPath), async () => {
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
        throw new NoteExistsError(resolved.fullPath)
      }
      throw err
    }
    await atomicWrite(noteFile(vaultId, resolved.fullPath), serializeNote({ frontmatter, body }))
    await regenProgressiveIndices(vaultId, resolved.ancestorDirectories)
    await syncLinks(row.id, body)
    scheduleEmbedding(row.id)
    await recordRevision(row.id, 'create', frontmatter, body, actor)
    return row
  })
}

/** Replaces the note's EXTRACTED link rows from its current wikilinks. */
export async function syncNoteLinks(noteId: string, body: string): Promise<void> {
  return syncLinks(noteId, body)
}

/** In one transaction: a rename looking for the notes that link to it
 * (linkReferrers) never sees this note between the delete and the insert,
 * with no links (#803). */
async function syncLinks(noteId: string, body: string): Promise<void> {
  const targets = extractWikilinks(body)
  await db.transaction(async (tx) => {
    await tx.delete(noteLinks).where(eq(noteLinks.sourceNoteId, noteId))
    if (targets.length > 0) {
      await tx
        .insert(noteLinks)
        .values(targets.map((targetPath) => ({ sourceNoteId: noteId, targetPath })))
        .onConflictDoNothing()
    }
  })
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

/**
 * A note's new body, or a function of its current body that the writer
 * applies under the note's lock: a rename's link rewrite (#803), which must
 * keep what other writers stored since the caller last read the note.
 */
export type BodyEdit = string | ((current: string) => string)

/**
 * Read-modify-write of one note's row, file, links and revision. Writes to the
 * same note are serialized (one at a time, in call order): run concurrently,
 * the row could end at one write and the file at another, and revisions could
 * be skipped or out of order. `options.quarantine` checks the body against
 * the stored one first (refuseSuspiciousWrite; the collab relay's store, which
 * passes the quarantine revision of the loaded document's episode, if any).
 * A `body` function (BodyEdit) gets the stored body.
 */
export async function updateNote(
  vaultId: string,
  path: string,
  input: { frontmatter?: Record<string, unknown>; body?: BodyEdit },
  actor: Actor = SYSTEM_ACTOR,
  options: { quarantine?: QuarantineRules; episode?: string } = {},
): Promise<NoteRow | null> {
  const resolved = resolveNotePath(path)
  return withKeyLock(noteLock(vaultId, resolved.fullPath), async () => {
    const row = await getLiveNote(vaultId, resolved.fullPath)
    if (!row) return null
    const edit = { frontmatter: input.frontmatter, body: typeof input.body === 'function' ? input.body(row.body) : input.body }
    const frontmatter: Frontmatter = {
      ...(input.frontmatter ?? (row.frontmatter as Frontmatter)),
      type: row.type,
    }
    const body = edit.body ?? row.body
    validateNote(row.type, row.name, frontmatter, body)
    // The size cap first: an over-cap body is refused, never kept as a quarantine revision (#491).
    assertBodyFits(body, row.body)
    if (options.quarantine) await refuseSuspiciousWrite(row, edit, actor, options.quarantine, options.episode)
    const [updated] = await db
      .update(notes)
      .set({ frontmatter, body, updatedAt: new Date() })
      .where(eq(notes.id, row.id))
      .returning()
    await atomicWrite(noteFile(vaultId, resolved.fullPath), serializeNote({ frontmatter, body }))
    // ponytail: progressive directory index.md files only catalog metadata/types/titles - skip vault-wide scans on body-only edits (GRAPH-05).
    // Key order is not compared: jsonb returns keys in its own order, while the collab store sends them in document order (#384).
    const frontmatterChanged =
      input.frontmatter !== undefined && !isDeepStrictEqual(row.frontmatter, frontmatter)
    if (frontmatterChanged) {
      await regenProgressiveIndices(vaultId, resolved.ancestorDirectories)
    }
    await syncLinks(row.id, body)
    scheduleEmbedding(row.id)
    await recordRevision(row.id, 'update', frontmatter, body, actor)
    return updated!
  })
}

/**
 * Rewrites wikilinks in a markdown document from one target path to another,
 * preserving any inner anchor `#heading`, custom label `|text`, or `.md` extension.
 */
export function refactorWikilinks(body: string, fromPath: string, toPath: string): string {
  const escaped = fromPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`\\[\\[([ \\t]*)${escaped}(\\.md)?([ \\t]*)(#[^\\]|]*)?(\\|[^\\]]*)?\\]\\]`, 'g')
  return body.replace(regex, (_match, p1, p2, p3, anchor = '', label = '') => {
    const ext = p2 ? '.md' : ''
    return `[[${p1}${toPath}${ext}${p3}${anchor}${label}]]`
  })
}

/**
 * Renames or moves a note. The move itself (row, file, CRDT state, folder
 * indexes, the note's own links) runs under the locks of both the old and the
 * new path (#484; `withKeyLocks` takes them in sorted order, so two renames
 * between the same paths never wait on each other in a cycle): a write to the
 * note waits for the move and then finds no note at the old path instead of
 * writing there, and of two writers making one path live (rename, create,
 * restore) the second finds the first's note there.
 *
 * Links in other notes are rewritten after the locks are released, each by
 * `updateFn` under that note's own lock: `writeThroughCollab` waits for the
 * relay's store hook, which code holding a note lock must never wait for
 * (ADR-003 §5.1), and two renames rewriting each other's referrers under
 * their own locks would each wait for the other's. Each referrer is found
 * again by id when its links are rewritten (relinkReferrer, #803).
 */
export async function renameNote(
  vaultId: string,
  from: string,
  toName: string,
  updateFn: (
    vaultId: string,
    path: string,
    input: { frontmatter?: Record<string, unknown>; body?: BodyEdit },
    actor: Actor,
  ) => Promise<NoteRow | null> = updateNote,
): Promise<NoteRow | null> {
  const fromResolved = resolveNotePath(from)
  let toPath: string
  if (isSlug(toName)) {
    toPath = fromResolved.directory ? `${fromResolved.directory}/${toName}` : toName
  } else {
    toPath = toName
  }
  const toResolved = resolveNotePath(toPath)
  const renaming = `renaming ${fromResolved.fullPath} to ${toResolved.fullPath}`
  const moved = await withKeyLocks(
    [noteLock(vaultId, fromResolved.fullPath), noteLock(vaultId, toResolved.fullPath)],
    () => moveNote(vaultId, fromResolved, toResolved, renaming),
  )
  if (!moved) return null

  // Refactor incoming wikilinks across other notes in the vault.
  for (const referrer of moved.referrers) {
    try {
      const relinked = await relinkReferrer(vaultId, referrer.id, moved.updated.id, fromResolved.fullPath, (path, body) =>
        updateFn(vaultId, path, { body }, SYSTEM_ACTOR),
      )
      if (!relinked) console.warn(`[rename] ${renaming}: links in ${referrer.path} not rewritten: the notes kept moving`)
    } catch (err) {
      // Grown past the cap since the check: the rename is done, so the other
      // referrers still get their links; this one keeps the old link.
      if (!(err instanceof NoteTooLargeError)) throw err
      console.warn(`[rename] ${renaming}: links in ${referrer.path} not rewritten: ${err.message}`)
    }
  }

  return moved.updated
}

/** Rounds relinkReferrer runs before it gives up on notes that keep moving. */
const RELINK_ROUNDS = 5

/**
 * Rewrites the links in note `referrerId` that name `fromPath`, the path
 * note `noteId` was renamed from, to the note's current path (renameNote,
 * after its locks are released). Both notes are looked up by id each round,
 * so one that another rename moved meanwhile is found where it is now
 * (#803), and `write` applies the rewrite to the body it reads under the
 * referrer's lock, so another rename's rewrite of the same note that landed
 * meanwhile is kept. A rename of the note that looked for referrers before
 * this write stored the new link did not find it: the note's path is read
 * again under that path's lock, and if the note has moved, the next round
 * rewrites the link to where it is now. False when the notes were still
 * moving after RELINK_ROUNDS rounds.
 */
async function relinkReferrer(
  vaultId: string,
  referrerId: string,
  noteId: string,
  fromPath: string,
  write: (path: string, body: (current: string) => string) => Promise<NoteRow | null>,
): Promise<boolean> {
  let linked = fromPath
  for (let round = 0; round < RELINK_ROUNDS; round++) {
    const [note] = await db.select({ path: notes.path }).from(notes).where(eq(notes.id, noteId))
    const [referrer] = await db
      .select({ path: notes.path, body: notes.body })
      .from(notes)
      .where(and(eq(notes.id, referrerId), eq(notes.vaultId, vaultId), isNull(notes.deletedAt)))
    if (!note || note.path === linked || !referrer) return true
    const from = linked
    const to = note.path
    const rewrite = (body: string) => refactorWikilinks(body, from, to)
    // No link left to rewrite: another rename's rewrite, or an edit, got there first.
    if (rewrite(referrer.body) === referrer.body) return true
    // No note, or another one, at the referrer's path: it moved meanwhile.
    if ((await write(referrer.path, rewrite))?.id !== referrerId) continue
    const settled = await withKeyLock(noteLock(vaultId, to), async () => {
      const [now] = await db.select({ path: notes.path }).from(notes).where(eq(notes.id, noteId))
      return now?.path === to
    })
    if (settled) return true
    linked = to
  }
  return false
}

/**
 * renameNote's move, run under the note locks of both paths. Returns the
 * moved row and the notes (id, and the path they had) whose links to the old
 * path renameNote rewrites next, or null when no live note is at the old path.
 */
async function moveNote(
  vaultId: string,
  fromResolved: ResolvedNotePath,
  toResolved: ResolvedNotePath,
  renaming: string,
): Promise<{ updated: NoteRow; referrers: { id: string; path: string }[] } | null> {
  const row = await getLiveNote(vaultId, fromResolved.fullPath)
  if (!row) return null
  if (toResolved.fullPath !== fromResolved.fullPath && (await getLiveNote(vaultId, toResolved.fullPath))) {
    throw new OkfValidationError(`a note already exists at ${toResolved.fullPath}`)
  }

  // Disk is canonical source (readNote), row is fallback.
  const existing = await readNote(vaultId, fromResolved.fullPath)
  const currentFrontmatter = (existing?.frontmatter ?? (row.frontmatter as Frontmatter)) as Frontmatter
  const rawBody = existing?.body ?? row.body
  const isMoving = fromResolved.fullPath !== toResolved.fullPath

  // Refactor any self-referential wikilinks in the note's own body
  const currentBody = isMoving
    ? refactorWikilinks(rawBody, fromResolved.fullPath, toResolved.fullPath)
    : rawBody

  const newFrontmatter: Frontmatter = {
    ...currentFrontmatter,
    type: toResolved.type,
  }
  validateNote(toResolved.type, toResolved.name, newFrontmatter, currentBody)
  // #491: rewriting links can grow a body past the size cap. Every rewritten
  // body (the note's own, then each referrer's) is checked before anything is
  // written, so a refused rename leaves the vault as it was.
  assertBodyFits(currentBody, rawBody, `${renaming} rewrites its own links`)
  const referrers = isMoving ? await linkReferrers(vaultId, row.id, fromResolved.fullPath) : []
  for (const { path } of referrers) {
    const referrer = await readNote(vaultId, path)
    if (!referrer) continue
    const rewritten = refactorWikilinks(referrer.body, fromResolved.fullPath, toResolved.fullPath)
    assertBodyFits(rewritten, referrer.body, `${renaming} rewrites its links in ${path}`)
  }

  const fromFile = noteFile(vaultId, fromResolved.fullPath)
  const toFile = noteFile(vaultId, toResolved.fullPath)

  if (isMoving) {
    await atomicWrite(toFile, serializeNote({ frontmatter: newFrontmatter, body: currentBody }))
    await unlink(fromFile).catch(() => {})
    await renameCrdtState(vaultId, fromResolved.fullPath, toResolved.fullPath).catch(() => {})
  } else {
    await atomicWrite(toFile, serializeNote({ frontmatter: newFrontmatter, body: currentBody }))
  }

  let updated: NoteRow
  try {
    const [u] = await db
      .update(notes)
      .set({
        name: toResolved.name,
        type: toResolved.type,
        path: toResolved.fullPath,
        body: currentBody,
        frontmatter: newFrontmatter,
        updatedAt: new Date(),
      })
      .where(eq(notes.id, row.id))
      .returning()
    updated = u!
  } catch (err) {
    if (isMoving) {
      await atomicWrite(fromFile, serializeNote({ frontmatter: currentFrontmatter, body: rawBody })).catch(() => {})
      await unlink(toFile).catch(() => {})
      await renameCrdtState(vaultId, toResolved.fullPath, fromResolved.fullPath).catch(() => {})
    }
    throw err
  }

  const affectedDirs = [
    ...new Set([...fromResolved.ancestorDirectories, ...toResolved.ancestorDirectories]),
  ]
  await regenProgressiveIndices(vaultId, affectedDirs)
  await syncLinks(updated.id, currentBody)
  return { updated, referrers }
}

/** The live notes (id and path), other than `noteId`, that link to `path`. */
async function linkReferrers(vaultId: string, noteId: string, path: string): Promise<{ id: string; path: string }[]> {
  const rows = await db
    .select({ id: notes.id, path: notes.path })
    .from(noteLinks)
    .innerJoin(notes, eq(notes.id, noteLinks.sourceNoteId))
    .where(
      and(
        eq(notes.vaultId, vaultId),
        ne(notes.id, noteId),
        isNull(notes.deletedAt),
        or(eq(noteLinks.targetPath, path), eq(noteLinks.targetPath, `${path}.md`)),
      ),
    )
  return [...new Map(rows.map((r) => [r.id, r])).values()]
}

/**
 * Soft delete (spec 6: one consistent delete behavior): file → .trash, row
 * keeps everything. Under the note's lock (#484): a write to the note that
 * waited for the delete finds no note instead of writing a file back.
 */
export async function softDeleteNote(
  vaultId: string,
  path: string,
  actor: Actor = SYSTEM_ACTOR,
): Promise<NoteRow | null> {
  const resolved = resolveNotePath(path)
  return withKeyLock(noteLock(vaultId, resolved.fullPath), async () => {
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
  })
}

/**
 * Runs `fn` on the trashed note `noteId` under the note lock of its path
 * (#484), so a restore and a purge of one note, or a restore and another
 * writer of its path, run one at a time. The row is read again inside the
 * lock: null when a writer that held it first restored or purged the note.
 */
async function withTrashedNote<T>(
  vaultId: string,
  noteId: string,
  fn: (row: NoteRow) => Promise<T>,
): Promise<T | null> {
  const trashed = and(eq(notes.id, noteId), eq(notes.vaultId, vaultId), isNotNull(notes.deletedAt))
  const [seen] = await db.select().from(notes).where(trashed)
  if (!seen) return null
  return withKeyLock(noteLock(vaultId, seen.path), async () => {
    const [row] = await db.select().from(notes).where(and(trashed, eq(notes.path, seen.path)))
    return row ? fn(row) : null
  })
}

export async function restoreNote(vaultId: string, noteId: string): Promise<NoteRow | null> {
  return withTrashedNote(vaultId, noteId, async (row) => {
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
  })
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

export type RevisionMeta = Pick<RevisionRow, 'id' | 'actorType' | 'actorId' | 'action' | 'createdAt'> & {
  /** The MCP connection's name on a revision an agent recorded; null for other actors or a deleted connection (#482). */
  actorName: string | null
}

/** Adds `actorName` to each revision: the History tab names the agent of a restore point with it (#482). */
async function withActorNames<T extends Pick<RevisionRow, 'actorType' | 'actorId'>>(
  rows: T[],
): Promise<Array<T & { actorName: string | null }>> {
  const ids = [...new Set(rows.flatMap((r) => (r.actorType === 'mcp' && r.actorId ? [r.actorId] : [])))]
  const connections =
    ids.length === 0
      ? []
      : await db
          .select({ id: mcpConnections.id, name: mcpConnections.name })
          .from(mcpConnections)
          .where(inArray(mcpConnections.id, ids))
  const names = new Map(connections.map((c) => [c.id, c.name]))
  return rows.map((r) => ({ ...r, actorName: (r.actorType === 'mcp' && r.actorId && names.get(r.actorId)) || null }))
}

/** One revision in an MCP history page: who changed the note, when, how, and how big the body was. */
export interface RevisionSummary extends RevisionMeta {
  /** UTF-8 bytes of the note body at this revision. */
  bodyBytes: number
}

/**
 * Where a history page ends: the last revision's `created_at` as microsecond
 * UTC text (a JS Date keeps only milliseconds, which would skip or repeat
 * revisions recorded within the same millisecond) and its id, which orders
 * revisions recorded in the same instant.
 */
export interface RevisionPosition {
  at: string
  id: string
}

/**
 * One page of a note's change history, newest first, metadata only (#411):
 * the bodies are never read (`octet_length` takes the size from the stored
 * value's header). Keyset-paged on (created_at, id) after `before`, so a
 * revision recorded while a caller pages does not shift the pages. `next` is
 * the position to continue from, or null on the last page. Null when the note
 * does not exist. Edit/owner only — enforced by callers.
 */
export async function listRevisionPage(
  vaultId: string,
  path: string,
  limit: number,
  before?: RevisionPosition,
): Promise<{ revisions: RevisionSummary[]; next: RevisionPosition | null } | null> {
  const row = await getLiveNote(vaultId, path)
  if (!row) return null
  const rows = await db
    .select({
      id: noteRevisions.id,
      actorType: noteRevisions.actorType,
      actorId: noteRevisions.actorId,
      action: noteRevisions.action,
      createdAt: noteRevisions.createdAt,
      bodyBytes: sql<number>`octet_length(${noteRevisions.body})`,
      at: sql<string>`to_char(${noteRevisions.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(noteRevisions)
    .where(
      and(
        eq(noteRevisions.noteId, row.id),
        before
          ? sql`(${noteRevisions.createdAt}, ${noteRevisions.id}) < (${before.at}::timestamptz, ${before.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(noteRevisions.createdAt), desc(noteRevisions.id))
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    revisions: await withActorNames(
      page.map((r) => ({
        id: r.id,
        actorType: r.actorType,
        actorId: r.actorId,
        action: r.action,
        createdAt: r.createdAt,
        bodyBytes: r.bodyBytes,
      })),
    ),
    next: rows.length > limit && last ? { at: last.at, id: last.id } : null,
  }
}

/** Revision metadata only — never a note's content — newest first, always
 * bounded (perf rule 3: no unbounded reads). The REST history list. */
export async function listRevisionMeta(
  vaultId: string,
  path: string,
  limit: number,
  offset: number,
): Promise<RevisionMeta[] | null> {
  const row = await getLiveNote(vaultId, path)
  if (!row) return null
  const rows = await db
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
  return withActorNames(rows)
}

/** Full content of a single recorded revision for preview / diff inspection. */
export async function getRevision(
  vaultId: string,
  revisionId: string,
): Promise<(RevisionRow & { path: string }) | null> {
  const rows = await db
    .select({
      id: noteRevisions.id,
      noteId: noteRevisions.noteId,
      path: notes.path,
      actorType: noteRevisions.actorType,
      actorId: noteRevisions.actorId,
      action: noteRevisions.action,
      frontmatter: noteRevisions.frontmatter,
      body: noteRevisions.body,
      createdAt: noteRevisions.createdAt,
    })
    .from(noteRevisions)
    .innerJoin(notes, eq(notes.id, noteRevisions.noteId))
    .where(and(eq(noteRevisions.id, revisionId), eq(notes.vaultId, vaultId)))
    .limit(1)

  const row = rows[0]
  if (!row) return null
  return row as RevisionRow & { path: string }
}

export interface BacklinkItem {
  id: string
  path: string
  type: string
  name: string
  title: string | null
  updatedAt: Date
}

/**
 * Returns incoming links to the given note path within the vault.
 * Resolves candidate wikilink targets (fullPath, fullPath.md, name, name.md).
 */
export async function getIncomingLinks(vaultId: string, path: string): Promise<BacklinkItem[] | null> {
  const target = await getLiveNote(vaultId, path)
  if (!target) return null

  const resolved = resolveNotePath(path)
  const candidateTargets = [resolved.fullPath, `${resolved.fullPath}.md`]
  if (resolved.name !== resolved.fullPath) {
    candidateTargets.push(resolved.name, `${resolved.name}.md`)
  }

  const rows = await db
    .select({
      id: notes.id,
      path: notes.path,
      type: notes.type,
      name: notes.name,
      frontmatter: notes.frontmatter,
      updatedAt: notes.updatedAt,
    })
    .from(noteLinks)
    .innerJoin(notes, eq(notes.id, noteLinks.sourceNoteId))
    .where(
      and(
        eq(notes.vaultId, vaultId),
        ne(notes.id, target.id),
        isNull(notes.deletedAt),
        inArray(noteLinks.targetPath, candidateTargets),
      ),
    )
    .orderBy(asc(notes.path))

  const seen = new Set<string>()
  const result: BacklinkItem[] = []
  for (const row of rows) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    const title =
      typeof (row.frontmatter as Record<string, unknown> | null)?.title === 'string'
        ? ((row.frontmatter as Record<string, unknown>).title as string)
        : null
    result.push({
      id: row.id,
      path: row.path,
      type: row.type,
      name: row.name,
      title,
      updatedAt: row.updatedAt,
    })
  }

  return result
}

export interface LocalGraphNode {
  id: string
  path: string
  name: string
  title: string | null
  type: string | null
  resourceType: 'note' | 'code'
  resourceId: string
  isCenter: boolean
  depth: number
}

export interface LocalGraphEdge {
  source: string
  target: string
  kind: 'extracted' | 'semantic'
  similarity?: number
}

export interface LocalGraphData {
  center: LocalGraphNode
  nodes: LocalGraphNode[]
  edges: LocalGraphEdge[]
}

/**
 * Returns a local ego graph (1 or 2 hops) around the given note.
 * Includes incoming backlinks, outgoing wikilinks, and semantic edges within the vault.
 */
export async function getLocalGraph(
  vaultId: string,
  path: string,
  depth = 1,
): Promise<LocalGraphData | null> {
  const target = await getLiveNote(vaultId, path)
  if (!target) return null

  const allNotes = await listNotes(vaultId)
  const byId = new Map(allNotes.map((n) => [n.id, n]))
  const byPath = new Map(allNotes.map((n) => [n.path, n]))
  const byName = new Map(allNotes.map((n) => [n.name, n]))

  function resolveLink(targetPath: string): (typeof allNotes)[number] | undefined {
    const clean = targetPath.endsWith('.md') ? targetPath.slice(0, -3) : targetPath
    return byPath.get(clean) ?? byName.get(clean) ?? byPath.get(targetPath) ?? byName.get(targetPath)
  }

  function candidateTargetsFor(p: string): string[] {
    const resolved = resolveNotePath(p)
    const candidates = [resolved.fullPath, `${resolved.fullPath}.md`]
    if (resolved.name !== resolved.fullPath) {
      candidates.push(resolved.name, `${resolved.name}.md`)
    }
    return candidates
  }

  const MAX_NODES = 50
  const oneHopIds = new Set<string>()
  const twoHopIds = new Set<string>()

  // 1-hop: Outgoing wikilinks from target
  const outgoingLinks = await db
    .select({ targetPath: noteLinks.targetPath })
    .from(noteLinks)
    .where(eq(noteLinks.sourceNoteId, target.id))

  for (const link of outgoingLinks) {
    const resolved = resolveLink(link.targetPath)
    if (resolved && resolved.id !== target.id) {
      oneHopIds.add(resolved.id)
    }
  }

  // 1-hop: Incoming backlinks to target
  const targetCandidates = candidateTargetsFor(path)
  const incomingLinks = await db
    .select({ sourceNoteId: noteLinks.sourceNoteId })
    .from(noteLinks)
    .where(inArray(noteLinks.targetPath, targetCandidates))

  for (const link of incomingLinks) {
    if (byId.has(link.sourceNoteId) && link.sourceNoteId !== target.id) {
      oneHopIds.add(link.sourceNoteId)
    }
  }

  // 1-hop: Semantic edges for target
  const semEdges = await db
    .select()
    .from(semanticEdges)
    .where(
      or(
        and(eq(semanticEdges.sourceType, 'note'), eq(semanticEdges.sourceId, target.id)),
        and(eq(semanticEdges.targetType, 'note'), eq(semanticEdges.targetId, target.id)),
      ),
    )

  for (const edge of semEdges) {
    const otherId = edge.sourceId === target.id ? edge.targetId : edge.sourceId
    if (byId.has(otherId) && otherId !== target.id) {
      oneHopIds.add(otherId)
    }
  }

  // 2-hop (if depth === 2)
  if (depth >= 2 && oneHopIds.size > 0 && oneHopIds.size < MAX_NODES) {
    const oneHopArr = [...oneHopIds]

    // Outgoing from 1-hop
    const twoHopOutgoing = await db
      .select({ sourceNoteId: noteLinks.sourceNoteId, targetPath: noteLinks.targetPath })
      .from(noteLinks)
      .where(inArray(noteLinks.sourceNoteId, oneHopArr))

    for (const link of twoHopOutgoing) {
      if (1 + oneHopIds.size + twoHopIds.size >= MAX_NODES) break
      const resolved = resolveLink(link.targetPath)
      if (resolved && resolved.id !== target.id && !oneHopIds.has(resolved.id)) {
        twoHopIds.add(resolved.id)
      }
    }

    // Incoming to 1-hop
    const oneHopCandidates: string[] = []
    for (const id of oneHopArr) {
      const n = byId.get(id)
      if (n) oneHopCandidates.push(...candidateTargetsFor(n.path))
    }

    if (oneHopCandidates.length > 0 && 1 + oneHopIds.size + twoHopIds.size < MAX_NODES) {
      const twoHopIncoming = await db
        .select({ sourceNoteId: noteLinks.sourceNoteId })
        .from(noteLinks)
        .where(inArray(noteLinks.targetPath, oneHopCandidates))

      for (const link of twoHopIncoming) {
        if (1 + oneHopIds.size + twoHopIds.size >= MAX_NODES) break
        if (byId.has(link.sourceNoteId) && link.sourceNoteId !== target.id && !oneHopIds.has(link.sourceNoteId)) {
          twoHopIds.add(link.sourceNoteId)
        }
      }
    }

    // Semantic to 1-hop
    if (1 + oneHopIds.size + twoHopIds.size < MAX_NODES) {
      const twoHopSem = await db
        .select()
        .from(semanticEdges)
        .where(
          or(
            and(eq(semanticEdges.sourceType, 'note'), inArray(semanticEdges.sourceId, oneHopArr)),
            and(eq(semanticEdges.targetType, 'note'), inArray(semanticEdges.targetId, oneHopArr)),
          ),
        )

      for (const edge of twoHopSem) {
        if (1 + oneHopIds.size + twoHopIds.size >= MAX_NODES) break
        const otherId = oneHopIds.has(edge.sourceId) ? edge.targetId : edge.sourceId
        if (byId.has(otherId) && otherId !== target.id && !oneHopIds.has(otherId)) {
          twoHopIds.add(otherId)
        }
      }
    }
  }

  // Construct node list
  const nodeMap = new Map<string, LocalGraphNode>()

  function makeNode(
    n: (typeof allNotes)[number] | NoteRow,
    d: number,
    isCenter: boolean,
  ): LocalGraphNode {
    const title =
      typeof (n.frontmatter as Record<string, unknown> | null)?.title === 'string'
        ? ((n.frontmatter as Record<string, unknown>).title as string)
        : null
    return {
      id: n.id,
      path: n.path,
      name: n.name,
      title,
      type: n.type,
      resourceType: 'note',
      resourceId: vaultId,
      isCenter,
      depth: d,
    }
  }

  const centerNode = makeNode(target, 0, true)
  nodeMap.set(centerNode.id, centerNode)

  for (const id of oneHopIds) {
    const n = byId.get(id)
    if (n) nodeMap.set(n.id, makeNode(n, 1, false))
  }

  for (const id of twoHopIds) {
    const n = byId.get(id)
    if (n) nodeMap.set(n.id, makeNode(n, 2, false))
  }

  const allNodeIds = [...nodeMap.keys()]

  // Collect all edges between nodes in the graph
  const edges: LocalGraphEdge[] = []
  const edgeKeys = new Set<string>()

  const allLinks = await db
    .select({ sourceNoteId: noteLinks.sourceNoteId, targetPath: noteLinks.targetPath })
    .from(noteLinks)
    .where(inArray(noteLinks.sourceNoteId, allNodeIds))

  for (const link of allLinks) {
    const resolved = resolveLink(link.targetPath)
    if (resolved && nodeMap.has(resolved.id) && link.sourceNoteId !== resolved.id) {
      const key = `${link.sourceNoteId}->${resolved.id}:extracted`
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key)
        edges.push({
          source: link.sourceNoteId,
          target: resolved.id,
          kind: 'extracted',
        })
      }
    }
  }

  // Collect semantic edges between nodes in graph
  const allSem = await db
    .select()
    .from(semanticEdges)
    .where(
      and(
        inArray(semanticEdges.sourceId, allNodeIds),
        inArray(semanticEdges.targetId, allNodeIds),
      ),
    )

  for (const sem of allSem) {
    const key =
      sem.sourceId < sem.targetId
        ? `${sem.sourceId}<->${sem.targetId}:semantic`
        : `${sem.targetId}<->${sem.sourceId}:semantic`
    if (!edgeKeys.has(key)) {
      edgeKeys.add(key)
      edges.push({
        source: sem.sourceId,
        target: sem.targetId,
        kind: 'semantic',
        similarity: sem.similarity,
      })
    }
  }

  return {
    center: centerNode,
    nodes: [...nodeMap.values()],
    edges,
  }
}

/** Restores a note to a recorded revision (a new attributed write). */
export async function revertNote(
  vaultId: string,
  path: string,
  revisionId: string,
  actor: Actor,
  updateFn: (
    vaultId: string,
    path: string,
    input: { frontmatter?: Record<string, unknown>; body?: string },
    actor: Actor,
  ) => Promise<NoteRow | null> = updateNote,
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
  const updated = await updateFn(
    vaultId,
    path,
    { frontmatter: revision.frontmatter as Record<string, unknown>, body: revision.body },
    actor,
  )
  if (updated) {
    const newest = (
      await db
        .select({ id: noteRevisions.id, action: noteRevisions.action })
        .from(noteRevisions)
        .where(and(eq(noteRevisions.noteId, row.id), ne(noteRevisions.action, QUARANTINE_ACTION)))
        .orderBy(desc(noteRevisions.createdAt))
        .limit(1)
    )[0]
    // A revert that records nothing (the state is already stored) must not relabel a restore point (#482).
    if (newest && newest.action !== RESTORE_POINT_ACTION) {
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

/** Permanently removes a trashed note (used by purge policies later), under its path's note lock (#484). */
export async function purgeNote(vaultId: string, noteId: string): Promise<boolean> {
  const purged = await withTrashedNote(vaultId, noteId, async (row) => {
    await db.delete(notes).where(eq(notes.id, row.id))
    // semanticEdges is polymorphic and has no FK (spec 9), so it does not
    // cascade — clear it by hand or the rows leak (#92).
    await deleteSemanticEdgesFor('note', [row.id])
    await rm(trashFile(vaultId, row.id), { force: true })
    await deleteCrdtState(vaultId, row.path).catch(() => {})
    return true
  })
  return purged ?? false
}

export const ASSET_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
}

export function sanitizeAssetFilename(originalFilename: string): string {
  const ext = extname(originalFilename).toLowerCase().slice(0, 10)
  const base =
    basename(originalFilename, ext)
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .slice(0, 40)
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'attachment'
  return `${base}-${Date.now()}-${randomUUID().slice(0, 6)}${ext}`
}

export function assetFile(vaultId: string, filename: string): string {
  return join(vaultDir(vaultId), 'assets', filename)
}

export async function saveAsset(
  vaultId: string,
  originalFilename: string,
  buffer: Buffer,
): Promise<{ fileName: string; size: number; mimeType: string }> {
  return writeAsset(vaultId, sanitizeAssetFilename(originalFilename), buffer)
}

/**
 * Writes an asset under exactly `fileName`, replacing a file of that name.
 * Callers pass a name that passed `isSafeAssetName` (vault import keeps the
 * archive's names so note links keep resolving, #499).
 */
export async function writeAsset(
  vaultId: string,
  fileName: string,
  buffer: Buffer,
): Promise<{ fileName: string; size: number; mimeType: string }> {
  const targetDir = join(vaultDir(vaultId), 'assets')
  await mkdir(targetDir, { recursive: true })
  await writeFile(join(targetDir, fileName), buffer)
  const ext = extname(fileName).toLowerCase()
  const mimeType = ASSET_MIME_TYPES[ext] ?? 'application/octet-stream'
  return { fileName, size: buffer.length, mimeType }
}

/** A bare file name inside a vault's `assets/` directory: no path parts, no traversal, not the directory itself. */
export function isSafeAssetName(filename: string): boolean {
  return Boolean(filename) && filename !== '.' && !filename.includes('..') && /^[a-zA-Z0-9._-]+$/.test(filename)
}

export async function readAsset(
  vaultId: string,
  filename: string,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  if (!isSafeAssetName(filename)) return null
  const filePath = assetFile(vaultId, filename)
  try {
    const buffer = await readFile(filePath)
    const ext = extname(filename).toLowerCase()
    const mimeType = ASSET_MIME_TYPES[ext] ?? 'application/octet-stream'
    return { buffer, mimeType }
  } catch {
    return null
  }
}

export async function listAssets(
  vaultId: string,
): Promise<{ fileName: string; size: number; modifiedAt: string }[]> {
  const targetDir = join(vaultDir(vaultId), 'assets')
  try {
    const entries = await readdir(targetDir, { withFileTypes: true })
    const results: { fileName: string; size: number; modifiedAt: string }[] = []
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue
      const stats = await stat(join(targetDir, entry.name)).catch(() => null)
      if (stats) {
        results.push({
          fileName: entry.name,
          size: stats.size,
          modifiedAt: stats.mtime.toISOString(),
        })
      }
    }
    return results.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
  } catch {
    return []
  }
}
