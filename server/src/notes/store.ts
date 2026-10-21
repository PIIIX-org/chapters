import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import * as Y from 'yjs'
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { mcpConnections, noteLinks, noteRevisions, notes, semanticEdges } from '../db/schema.js'
import { config } from '../config.js'
import { kickEmbeddings } from '../search/embedding-queue.js'
import { deleteSemanticEdgesFor } from '../search/semantic-edges.js'
import { deleteCrdtState, renameCrdtState, saveCrdtState } from '../sync/crdt-store.js'
import {
  cloneDocument,
  docState,
  loadedDocument,
  pushToDocument,
  updateBin,
  type DocState,
  type LiveDocument,
} from '../sync/live-docs.js'
import { failpoint } from '../failpoints.js'
import {
  OkfValidationError,
  validateNote,
  isSlug,
  type Frontmatter,
} from './okf.js'
import {
  resolveNotePath,
  type ResolvedNotePath,
  splitPath,
} from './okf/paths.js'
import { withKeyLock, withKeyLocks } from './key-lock.js'
import { assertBodyFits, NoteTooLargeError } from './size-cap.js'
import { NoteWriteQuarantinedError, suspiciousWrite, type QuarantineRules } from './growth-guard.js'
import { orderKeys, presentedFrontmatter, sameContent } from './frontmatter-order.js'
import {
  StoreBusyError,
  applyRowChange,
  enqueueEmbeddingTx,
  insertRevision,
  insertStoreJob,
  lockedNote,
  pgErrorCode,
  raiseProjections,
  replaceLinks,
  storeTransaction,
  storedColumns,
  toStored,
  type StoredNote,
  type Tx,
} from './store-tx.js'
import { STORE_JOBS, registerRenameRefactor, wakeProjector, type RenameRefactorPayload } from './projector.js'
import { completeJob } from '../jobs/durable.js'

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
class NoteExistsError extends OkfValidationError {
  constructor(path: string) {
    super(`a note already exists at ${path}`)
  }
}

/** The `note_revisions.action` of a write kept out of the note (#492, notes/growth-guard.ts). */
export const QUARANTINE_ACTION = 'quarantine'

/** The `note_revisions.action` of the state kept before an agent's first write in a session (#482). */
export const RESTORE_POINT_ACTION = 'restore_point'

/**
 * The `note_revisions.action` of an agent's edit kept out of the note because
 * it overlaps changes made since the revision it was made from (#475,
 * edit_note `base_rev`); its `source_revision_id` names that revision.
 */
export const PROPOSAL_ACTION = 'proposal'

/** Revisions that never held the note's content: writes kept out of it (#492, #475). */
const NOT_A_NOTE_STATE = [QUARANTINE_ACTION, PROPOSAL_ACTION]

/** An MCP connection's session on a note ends after this many minutes without a revision of its own there (#482). */
export const RESTORE_POINT_IDLE_MINUTES = 30

/**
 * Runs an MCP connection's write to a note and, when it is the connection's
 * first write to that note in a session (#482), keeps the state the note had
 * just before it as a `restore_point` revision attributed to the connection:
 * one revert to it undoes everything that agent did in the session.
 *
 * MCP is served as stateless HTTP with no session id, so a session is the
 * connection on this note until it has recorded no revision there for
 * RESTORE_POINT_IDLE_MINUTES (quarantined writes and proposals do not count:
 * they are not the note's state). The state is read before the write and
 * recorded, dated at that read, only when `write` returns a result: a refused or failed write
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
        notInArray(noteRevisions.action, NOT_A_NOTE_STATE),
        sql`${noteRevisions.createdAt} > now() - make_interval(mins => ${RESTORE_POINT_IDLE_MINUTES})`,
      ),
    )
    .limit(1)
  if (active.length > 0) return null
  const last = (
    await db
      .select()
      .from(noteRevisions)
      .where(and(eq(noteRevisions.noteId, row.id), notInArray(noteRevisions.action, NOT_A_NOTE_STATE)))
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

/**
 * Keeps an agent's edit that overlaps changes made since the revision it was
 * made from (#475) as a `proposal` revision linked to that revision; the
 * note's row and file are not touched. When the actor's latest proposal on
 * the note is the same one (same base, same content), a retry returns it
 * instead of adding one per attempt. Returns the proposal's id.
 */
export async function recordProposal(
  noteId: string,
  proposal: { frontmatter: Record<string, unknown>; body: string },
  actor: Actor,
  baseRevisionId: string,
): Promise<string> {
  const frontmatter = JSON.parse(JSON.stringify(proposal.frontmatter)) as Record<string, unknown>
  const [latest] = await db
    .select({
      id: noteRevisions.id,
      frontmatter: noteRevisions.frontmatter,
      body: noteRevisions.body,
      sourceRevisionId: noteRevisions.sourceRevisionId,
    })
    .from(noteRevisions)
    .where(
      and(
        eq(noteRevisions.noteId, noteId),
        eq(noteRevisions.action, PROPOSAL_ACTION),
        eq(noteRevisions.actorType, actor.type),
        actor.id === undefined ? isNull(noteRevisions.actorId) : eq(noteRevisions.actorId, actor.id),
      ),
    )
    .orderBy(desc(noteRevisions.createdAt), desc(noteRevisions.id))
    .limit(1)
  if (latest?.sourceRevisionId === baseRevisionId && latest.body === proposal.body && isDeepStrictEqual(latest.frontmatter, frontmatter)) {
    return latest.id
  }
  const [inserted] = await db
    .insert(noteRevisions)
    .values({
      noteId,
      actorType: actor.type,
      actorId: actor.id,
      action: PROPOSAL_ACTION,
      frontmatter,
      body: proposal.body,
      sourceRevisionId: baseRevisionId,
    })
    .returning({ id: noteRevisions.id })
  return inserted!.id
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

function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === '23505'
}

/**
 * The key-lock.ts key held by every writer of the note at `path`: create,
 * update, rename (both paths), delete, restore and purge (#401, #484), and
 * the relay's load and store hooks of the path-named document (ADR-003
 * §5.2, S2a). It stays keyed by path (#484, #803); the Postgres lock every
 * store transaction takes is keyed by note id (store-tx.ts).
 */
export function noteLock(vaultId: string, path: string): string {
  return `note:${vaultId}/${path}`
}

/** A row as callers see it: the model's columns only (`seq` and `frontmatter_src` stay internal until #477). */
function plainRow(row: StoredNote): NoteRow {
  const plain: Partial<StoredNote> = { ...row }
  delete plain.seq
  delete plain.frontmatterSrc
  // Only the two internal fields were removed: the rest is the model's row.
  return plain as NoteRow
}

/**
 * The relay's loaded document of the note at `path`, cloned before a write
 * (ADR-003 §5.2 step 3, S2a): its state is what the editors see, which the
 * write stores first and compiles its change against; the clone is the base
 * the committed change is pushed into the document from (step 8).
 */
interface Fold {
  live: LiveDocument
  base: Y.Doc
  state: DocState
}

function foldSource(vaultId: string, path: string): Fold | null {
  const live = loadedDocument(vaultId, path)
  if (!live) return null
  const base = cloneDocument(live.doc)
  return { live, base, state: docState(base) }
}

/**
 * Invariant W, S2a (§5.2 step 3): stores the loaded document's state as a
 * revision of its editors before a write changes the note, in the write's
 * transaction. A state the relay itself would refuse (invalid, over the cap,
 * a repeated block, #491/#492) is not stored; the write is then compiled
 * against it and stands or falls on its own validation.
 */
async function foldLive(tx: Tx, row: StoredNote, fold: Fold | null): Promise<StoredNote> {
  if (!fold) return row
  const frontmatter = { ...fold.state.frontmatter, type: row.type } as Frontmatter
  if (fold.state.body === row.body && sameContent(frontmatter, row.frontmatter as Record<string, unknown>)) return row
  try {
    validateNote(row.type, row.name, frontmatter, fold.state.body)
    assertBodyFits(fold.state.body, row.body)
  } catch {
    return row
  }
  if (suspiciousWrite(row.body, fold.state.body, 'repeated-block')) return row
  const { row: folded } = await applyRowChange(
    tx,
    row,
    { frontmatter, body: fold.state.body },
    { action: 'update', actor: SYSTEM_ACTOR, actorDetail: { kind: 'fold', editors: fold.live.editors } },
    { frontmatterOrder: orderKeys(row.frontmatterSrc, fold.state.frontmatter) },
  )
  return folded
}

/**
 * After commit, still under the note lock (§5.2 step 8, S2a): pushes the
 * committed state into the loaded document, or else keeps the note's `.crdt`
 * bin equal to it. A document that unloaded meanwhile gets its bin updated.
 */
async function pushCommitted(vaultId: string, path: string, fold: Fold | null, committed: StoredNote): Promise<void> {
  failpoint('edit.after-commit-before-live-apply')
  const state = { frontmatter: committed.frontmatter as Record<string, unknown>, body: committed.body }
  if (fold && loadedDocument(vaultId, path)?.doc === fold.live.doc) {
    pushToDocument(fold.live.doc, fold.base, state)
    return
  }
  fold?.base.destroy()
  try {
    await updateBin(vaultId, path, state)
  } catch (err) {
    console.warn(`[store] ${vaultId}/${path}: .crdt bin not updated: ${(err as Error).message}`)
  }
}

/** Wakes the workers that follow a commit: the projector (files, index.md) and the embedding worker. */
function afterCommit(): void {
  wakeProjector()
  kickEmbeddings()
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
    const id = randomUUID()
    let row: NoteRow
    try {
      // One transaction (ADR-003 §5.3): row, revision at seq 1, links, projection targets, embedding job.
      row = await storeTransaction([id], async (tx) => {
        const [inserted] = await tx
          .insert(notes)
          .values({ id, vaultId, type: resolved.type, name: resolved.name, path: resolved.fullPath, frontmatter, body })
          .returning()
        await tx.execute(sql`UPDATE notes SET frontmatter_src = ${JSON.stringify(frontmatter)}::json WHERE id = ${id}`)
        await insertRevision(tx, id, 1, { action: 'create', actor }, { frontmatter, body })
        await replaceLinks(tx, id, body)
        await raiseProjections(tx, id, 1, ['file', 'dir_index'])
        await enqueueEmbeddingTx(tx, id, 1)
        return inserted!
      })
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new NoteExistsError(resolved.fullPath)
      }
      throw err
    }
    failpoint('create.after-commit-before-file')
    afterCommit()
    return row
  })
}

/**
 * createNote when there is no live note at the path, else null (append_note,
 * upsert_note, #478): concurrent callers create the note once, and the rest
 * then edit it like any existing note (restore point included). Path
 * uniqueness is the unique index's (ADR-003 §5.1): a writer that creates the
 * note between the check and the insert (another caller, create_note,
 * restore_note) makes the insert fail, which answers null too.
 */
export async function createNoteIfMissing(
  vaultId: string,
  input: Parameters<typeof createNote>[1] & { path: string },
  actor: Actor,
): Promise<NoteRow | null> {
  if (await getLiveNote(vaultId, input.path)) return null
  try {
    return await createNote(vaultId, input, actor)
  } catch (err) {
    if (err instanceof NoteExistsError) return null
    throw err
  }
}

/** Replaces the note's EXTRACTED link rows from its current wikilinks (`pnpm reindex`). */
export async function syncNoteLinks(noteId: string, body: string): Promise<void> {
  await db.transaction((tx) => replaceLinks(tx, noteId, body))
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
 * Reads a live note from the database, the only authority (ADR-003 §6):
 * the row, with its frontmatter in the key order of its file
 * (`frontmatter_src`). The `.md` file is a projection and is never read
 * back, so a note whose file is missing, damaged or not yet written reads
 * the same as any other.
 */
export async function readNote(
  vaultId: string,
  path: string,
): Promise<{ row: NoteRow; frontmatter: Frontmatter; body: string } | null> {
  const row = await readStored(vaultId, resolveNotePath(path).fullPath)
  if (!row) return null
  return { row: plainRow(row), frontmatter: presentedFrontmatter(row.frontmatter, row.frontmatterSrc) as Frontmatter, body: row.body }
}

/** The live note at `path` with `seq` and `frontmatter_src`, read without locks. */
async function readStored(vaultId: string, path: string): Promise<StoredNote | null> {
  const [row] = await db
    .select(storedColumns)
    .from(notes)
    .where(and(eq(notes.vaultId, vaultId), eq(notes.path, path), isNull(notes.deletedAt)))
  return row ? toStored(row) : null
}

/**
 * A note's new body, or a function of its current body that the writer
 * applies under the note's lock: a rename's link rewrite (#803), which must
 * keep what other writers stored since the caller last read the note.
 */
export type BodyEdit = string | ((current: string) => string)

/** The state a write leaves the note in, computed from its current state (`compute` of writeNote). */
export interface NextState {
  frontmatter: Frontmatter
  body: string
}

/** How a write is recorded and where it comes from. */
export interface WriteOptions {
  /** The revision this write brings back (revertNote): recorded as a `revert` event (#479). */
  revertOf?: string
  /** Recorded on the revision (#403): the MCP tool, the editors of a fold. */
  actorDetail?: Record<string, unknown>
  /**
   * The relay's own store of its document (collab-server.ts): the note it
   * loaded (`noteId`, the store goes nowhere else, §5.5). It is the live
   * document, so nothing is folded first or pushed back.
   */
  relay?: { noteId: string }
}

/** Times a write recomputes when another process changed the note between its read and its lock. */
const WRITE_ROUNDS = 3

/**
 * One server write to the live note at `path` (ADR-003 §5.2, Invariant W),
 * under the note's lock:
 * 1. the current state is the relay's loaded document if there is one (what
 *    the editors see), else the row; `compute` turns it into the next state
 *    and refuses by throwing (validation, size cap, quarantine, overlap);
 * 2. one transaction: the instance and note locks, the row again (FOR
 *    UPDATE; a row another process changed meanwhile recomputes), the loaded
 *    document's state stored first, then the write: row, revision at the new
 *    `seq`, links, projection targets, embedding job; COMMIT is the ack;
 * 3. the committed state pushed into the loaded document, or the `.crdt` bin
 *    kept equal to it; the projector woken.
 * Null when no live note is at `path` (or it is not `options.relay.noteId`).
 */
export async function writeNote(
  vaultId: string,
  path: string,
  compute: (current: { frontmatter: Record<string, unknown>; body: string }, row: NoteRow) => Promise<NextState> | NextState,
  actor: Actor,
  options: WriteOptions = {},
): Promise<NoteRow | null> {
  const resolved = resolveNotePath(path)
  return withKeyLock(noteLock(vaultId, resolved.fullPath), async () => {
    for (let round = 0; round < WRITE_ROUNDS; round++) {
      const seen = await readStored(vaultId, resolved.fullPath)
      if (!seen || (options.relay && seen.id !== options.relay.noteId)) return null
      const fold = options.relay ? null : foldSource(vaultId, resolved.fullPath)
      const current = fold?.state ?? { frontmatter: seen.frontmatter as Record<string, unknown>, body: seen.body }
      let next: NextState
      try {
        next = await compute(current, plainRow(seen))
      } catch (err) {
        fold?.base.destroy()
        throw err
      }
      const committed = await storeTransaction([seen.id], async (tx) => {
        const locked = await lockedNote(tx, seen.id)
        if (!locked || locked.deletedAt || locked.path !== resolved.fullPath) return null
        if (locked.seq !== seen.seq) return 'moved' as const
        const row = await foldLive(tx, locked, fold)
        const { row: written } = await applyRowChange(
          tx,
          row,
          { frontmatter: { ...next.frontmatter, type: row.type }, body: next.body },
          options.revertOf
            ? { action: 'revert', actor, sourceRevisionId: options.revertOf, actorDetail: options.actorDetail }
            : { action: 'update', actor, actorDetail: options.actorDetail },
        )
        failpoint('edit.before-commit')
        return written
      })
      if (committed === 'moved') {
        fold?.base.destroy()
        continue
      }
      if (!committed) {
        fold?.base.destroy()
        return null
      }
      if (!options.relay) await pushCommitted(vaultId, resolved.fullPath, fold, committed)
      afterCommit()
      failpoint('edit.after-commit-before-ack')
      return plainRow(committed)
    }
    throw new StoreBusyError('the note kept changing')
  })
}

/**
 * Writes `input` to the live note at `path` (writeNote): a field left out
 * keeps its current value, a `body` function (BodyEdit) gets the current
 * body. `options.quarantine` checks the body against the stored one first
 * (refuseSuspiciousWrite; the collab relay's store passes the quarantine
 * revision of the loaded document's episode, if any).
 */
export async function updateNote(
  vaultId: string,
  path: string,
  input: { frontmatter?: Record<string, unknown>; body?: BodyEdit },
  actor: Actor = SYSTEM_ACTOR,
  options: WriteOptions & { quarantine?: QuarantineRules; episode?: string } = {},
): Promise<NoteRow | null> {
  return writeNote(
    vaultId,
    path,
    async (current, row) => {
      const body = typeof input.body === 'function' ? input.body(current.body) : (input.body ?? current.body)
      const frontmatter: Frontmatter = { ...(input.frontmatter ?? current.frontmatter), type: row.type }
      validateNote(row.type, row.name, frontmatter, body)
      // The size cap first: an over-cap body is refused, never kept as a quarantine revision (#491).
      assertBodyFits(body, row.body)
      if (options.quarantine) {
        await refuseSuspiciousWrite(row, { frontmatter: input.frontmatter, body }, actor, options.quarantine, options.episode)
      }
      return { frontmatter, body }
    },
    actor,
    options,
  )
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

/** Writes a referrer's rewritten links: the rename's `updateFn` (MCP passes writeThroughCollab). */
type ReferrerWrite = (
  vaultId: string,
  path: string,
  input: { frontmatter?: Record<string, unknown>; body?: BodyEdit },
  actor: Actor,
) => Promise<NoteRow | null>

/**
 * Renames or moves a note to `toName` (a slug in its folder, or a path),
 * rewriting the links to it; the move is recorded as a `rename` event by
 * `actor` (#479). The move (ADR-003 §5.5) is one transaction under the
 * note locks of both paths (#484; `withKeyLocks` takes them in sorted
 * order): the editors' typing first, then row, revision, the note's own
 * links, projection targets (the projector writes the new file, releases
 * the old one and regenerates the index.md of both folders), and a
 * `store_rename_refactor` job naming the notes that link to the old path,
 * fixed inside the transaction, so a note later created at the old path
 * never has its incoming links re-targeted.
 *
 * Links in other notes are rewritten after the locks are released, each by
 * `updateFn` under that note's own lock (two renames rewriting each other's
 * referrers under their own locks would each wait for the other), and
 * credited to the rename's actor (#403). The job is leased while this runs;
 * after a crash the projector resumes it.
 */
export async function renameNote(
  vaultId: string,
  from: string,
  toName: string,
  actor: Actor = SYSTEM_ACTOR,
  updateFn: ReferrerWrite = updateNote,
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
    () => moveNote(vaultId, fromResolved, toResolved, renaming, actor),
  )
  if (!moved) return null
  failpoint('rename.after-commit-before-refactor')
  if (moved.job !== null) {
    await runRenameRefactor(
      { vaultId, noteId: moved.updated.id, fromPath: fromResolved.fullPath, referrers: moved.referrers, actor },
      updateFn,
    )
    await completeJob(moved.job)
  }
  return moved.updated
}

/**
 * The referrer refactor of a rename (job `store_rename_refactor`): rewrites
 * the links to `fromPath` in each referrer, by id. Grown past the size cap
 * since the rename's check: that referrer keeps the old link, the others
 * still get theirs.
 */
async function runRenameRefactor(payload: RenameRefactorPayload, updateFn: ReferrerWrite = updateNote): Promise<void> {
  const renaming = `renaming ${payload.fromPath}`
  const actor = payload.actor ?? SYSTEM_ACTOR
  for (const referrerId of payload.referrers) {
    try {
      const relinked = await relinkReferrer(payload.vaultId, referrerId, payload.noteId, payload.fromPath, (path, body) =>
        updateFn(payload.vaultId, path, { body }, actor),
      )
      if (!relinked) console.warn(`[rename] ${renaming}: links in note ${referrerId} not rewritten: the notes kept moving`)
    } catch (err) {
      if (!(err instanceof NoteTooLargeError)) throw err
      console.warn(`[rename] ${renaming}: links in note ${referrerId} not rewritten: ${err.message}`)
    }
  }
}

registerRenameRefactor((payload) => runRenameRefactor(payload))

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

/** How long a rename holds its referrer refactor job while it runs it itself; after a crash the projector takes it over. */
const RENAME_REFACTOR_LEASE_MS = 10 * 60_000

/**
 * renameNote's move, run under the note locks of both paths. Returns the
 * moved row, the ids of the notes whose links to the old path renameNote
 * rewrites next, and the id of the leased `store_rename_refactor` job (null
 * when there is nothing to rewrite), or null when no live note is at the old path.
 */
async function moveNote(
  vaultId: string,
  fromResolved: ResolvedNotePath,
  toResolved: ResolvedNotePath,
  renaming: string,
  actor: Actor,
): Promise<{ updated: NoteRow; referrers: string[]; job: number | null } | null> {
  const seen = await readStored(vaultId, fromResolved.fullPath)
  if (!seen) return null
  if (toResolved.fullPath !== fromResolved.fullPath && (await getLiveNote(vaultId, toResolved.fullPath))) {
    throw new OkfValidationError(`a note already exists at ${toResolved.fullPath}`)
  }
  const isMoving = fromResolved.fullPath !== toResolved.fullPath
  const fold = foldSource(vaultId, fromResolved.fullPath)
  const current = fold?.state ?? { frontmatter: seen.frontmatter as Record<string, unknown>, body: seen.body }
  // Self-referential wikilinks in the note's own body follow it.
  const newBody = isMoving ? refactorWikilinks(current.body, fromResolved.fullPath, toResolved.fullPath) : current.body
  const newFrontmatter: Frontmatter = { ...current.frontmatter, type: toResolved.type }
  let result: { updated: StoredNote; referrers: string[]; job: number | null } | null
  try {
    validateNote(toResolved.type, toResolved.name, newFrontmatter, newBody)
    // #491: rewriting links can grow a body past the size cap. Every rewritten
    // body (the note's own, then each referrer's) is checked before anything is
    // written, so a refused rename leaves the vault as it was.
    assertBodyFits(newBody, current.body, `${renaming} rewrites its own links`)
    result = await storeTransaction([seen.id], async (tx) => {
      const locked = await lockedNote(tx, seen.id)
      if (!locked || locked.deletedAt || locked.path !== fromResolved.fullPath) return null
      const row = await foldLive(tx, locked, fold)
      const referrers = isMoving ? await linkReferrers(tx, vaultId, row.id, fromResolved.fullPath) : []
      for (const referrer of referrers) {
        const rewritten = refactorWikilinks(referrer.body, fromResolved.fullPath, toResolved.fullPath)
        assertBodyFits(rewritten, referrer.body, `${renaming} rewrites its links in ${referrer.path}`)
      }
      const { row: updated } = await applyRowChange(
        tx,
        row,
        { path: toResolved.fullPath, type: toResolved.type, name: toResolved.name, frontmatter: newFrontmatter, body: newBody },
        isMoving
          ? { action: 'rename', actor, fromPath: fromResolved.fullPath, toPath: toResolved.fullPath }
          : { action: 'update', actor },
      )
      if (isMoving) {
        // The folders the note left: their index.md no longer lists it.
        await insertStoreJob(tx, STORE_JOBS.dirIndex, { vaultId, dirs: fromResolved.ancestorDirectories })
      }
      const job =
        referrers.length > 0
          ? await insertStoreJob(
              tx,
              STORE_JOBS.renameRefactor,
              { vaultId, noteId: updated.id, fromPath: fromResolved.fullPath, referrers: referrers.map((r) => r.id), actor },
              { leaseMs: RENAME_REFACTOR_LEASE_MS },
            )
          : null
      return { updated, referrers: referrers.map((r) => r.id), job }
    })
  } catch (err) {
    fold?.base.destroy()
    if (isUniqueViolation(err)) throw new OkfValidationError(`a note already exists at ${toResolved.fullPath}`)
    throw err
  }
  if (!result) {
    fold?.base.destroy()
    return null
  }
  // S2a (§5.5): the old-path document or bin gets the change, then the bin moves with the note.
  await pushCommitted(vaultId, fromResolved.fullPath, fold, result.updated)
  if (isMoving) {
    const live = loadedDocument(vaultId, fromResolved.fullPath)
    if (live) await saveCrdtState(vaultId, fromResolved.fullPath, Y.encodeStateAsUpdate(live.doc)).catch(() => {})
    await renameCrdtState(vaultId, fromResolved.fullPath, toResolved.fullPath).catch(() => {})
  }
  afterCommit()
  return { updated: plainRow(result.updated), referrers: result.referrers, job: result.job }
}

/** The live notes (id, path, body), other than `noteId`, that link to `path`. */
async function linkReferrers(
  tx: Tx,
  vaultId: string,
  noteId: string,
  path: string,
): Promise<{ id: string; path: string; body: string }[]> {
  const rows = await tx
    .select({ id: notes.id, path: notes.path, body: notes.body })
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
 * Soft delete (spec 6: one consistent delete behavior): the row keeps
 * everything; the projector moves the file to `.trash/<id>.md` and
 * regenerates the folder indexes. One transaction under the note's lock
 * (#484), after the editors' typing is stored (Invariant W): a write to the
 * note that waited for the delete finds no note instead of writing.
 */
export async function softDeleteNote(
  vaultId: string,
  path: string,
  actor: Actor = SYSTEM_ACTOR,
): Promise<NoteRow | null> {
  const resolved = resolveNotePath(path)
  return withKeyLock(noteLock(vaultId, resolved.fullPath), async () => {
    const seen = await readStored(vaultId, resolved.fullPath)
    if (!seen) return null
    const fold = foldSource(vaultId, resolved.fullPath)
    try {
      const deleted = await storeTransaction([seen.id], async (tx) => {
        const locked = await lockedNote(tx, seen.id)
        if (!locked || locked.deletedAt || locked.path !== resolved.fullPath) return null
        const row = await foldLive(tx, locked, fold)
        return (await applyRowChange(tx, row, { deletedAt: new Date() }, { action: 'delete', actor })).row
      })
      if (!deleted) return null
      afterCommit()
      return plainRow(deleted)
    } finally {
      fold?.base.destroy()
    }
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

/** Restores a trashed note (one transaction, revision `restore`, #479); the projector moves its file back. */
export async function restoreNote(
  vaultId: string,
  noteId: string,
  actor: Actor = SYSTEM_ACTOR,
): Promise<NoteRow | null> {
  return withTrashedNote(vaultId, noteId, async (seen) => {
    if (await getLiveNote(vaultId, seen.path)) {
      throw new OkfValidationError(`a live note already exists at ${seen.path}`)
    }
    let restored: StoredNote | null
    try {
      restored = await storeTransaction([seen.id], async (tx) => {
        const locked = await lockedNote(tx, seen.id)
        if (!locked || !locked.deletedAt) return null
        return (await applyRowChange(tx, locked, { deletedAt: null }, { action: 'restore', actor })).row
      })
    } catch (err) {
      if (isUniqueViolation(err)) throw new OkfValidationError(`a live note already exists at ${seen.path}`)
      throw err
    }
    if (!restored) return null
    afterCommit()
    return plainRow(restored)
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

/** The event fields of a revision (#479), present only on the rows that have
 * them (a revert's source, a proposal's base (#475), a rename's paths), so a
 * plain row costs nothing more. */
export interface RevisionEventDetail {
  sourceRevisionId?: string
  fromPath?: string
  toPath?: string
}

export type RevisionMeta = Pick<RevisionRow, 'id' | 'actorType' | 'actorId' | 'action' | 'createdAt'> &
  RevisionEventDetail & {
    /** The MCP connection's name on a revision an agent recorded; null for other actors or a deleted connection (#482). */
    actorName: string | null
  }

/** One recorded revision with its content and the note's current path. */
export type RevisionDetail = Omit<RevisionRow, keyof RevisionEventDetail> & RevisionEventDetail & { path: string }

const eventColumns = {
  sourceRevisionId: noteRevisions.sourceRevisionId,
  fromPath: noteRevisions.fromPath,
  toPath: noteRevisions.toPath,
}

function eventDetail(r: { sourceRevisionId: string | null; fromPath: string | null; toPath: string | null }): RevisionEventDetail {
  return {
    ...(r.sourceRevisionId === null ? {} : { sourceRevisionId: r.sourceRevisionId }),
    ...(r.fromPath === null ? {} : { fromPath: r.fromPath }),
    ...(r.toPath === null ? {} : { toPath: r.toPath }),
  }
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
      ...eventColumns,
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
        ...eventDetail(r),
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
      ...eventColumns,
    })
    .from(noteRevisions)
    .where(eq(noteRevisions.noteId, row.id))
    .orderBy(desc(noteRevisions.createdAt))
    .limit(limit)
    .offset(offset)
  return withActorNames(
    rows.map(({ sourceRevisionId, fromPath, toPath, ...meta }) => ({
      ...meta,
      ...eventDetail({ sourceRevisionId, fromPath, toPath }),
    })),
  )
}

/** Full content of a single recorded revision for preview / diff inspection; a proposal (#475) also names its base. */
export async function getRevision(
  vaultId: string,
  revisionId: string,
): Promise<RevisionDetail | null> {
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
      ...eventColumns,
    })
    .from(noteRevisions)
    .innerJoin(notes, eq(notes.id, noteRevisions.noteId))
    .where(and(eq(noteRevisions.id, revisionId), eq(notes.vaultId, vaultId)))
    .limit(1)

  const row = rows[0]
  if (!row) return null
  const { sourceRevisionId, fromPath, toPath, ...revision } = row
  return { ...revision, ...eventDetail({ sourceRevisionId, fromPath, toPath }) }
}

/**
 * The id of the newest revision holding exactly this state of the note: the
 * `rev` read_note and edit_note return, which edit_note takes back as
 * `base_rev` (#475). Only the newest 20 revisions that held the note's
 * content are compared (jsonb equality for the frontmatter, so key order
 * does not count); null when none of them holds this state.
 */
export async function revisionOfState(noteId: string, state: { frontmatter: unknown; body: string }): Promise<string | null> {
  const recent = db
    .select({ id: noteRevisions.id, frontmatter: noteRevisions.frontmatter, body: noteRevisions.body, createdAt: noteRevisions.createdAt })
    .from(noteRevisions)
    .where(and(eq(noteRevisions.noteId, noteId), notInArray(noteRevisions.action, NOT_A_NOTE_STATE)))
    .orderBy(desc(noteRevisions.createdAt), desc(noteRevisions.id))
    .limit(20)
    .as('recent')
  const [found] = await db
    .select({ id: recent.id })
    .from(recent)
    .where(and(eq(recent.body, state.body), sql`${recent.frontmatter} = ${JSON.stringify(state.frontmatter ?? null)}::jsonb`))
    .orderBy(desc(recent.createdAt), desc(recent.id))
    .limit(1)
  return found?.id ?? null
}

/**
 * The revision an edit says it was made from (edit_note `base_rev`, #475): a
 * revision of the live note at `path` that held its content. Null when there
 * is no such note or the revision is not one of its states.
 */
export async function getBaseRevision(
  vaultId: string,
  path: string,
  revisionId: string,
): Promise<Pick<RevisionRow, 'id' | 'frontmatter' | 'body'> | null> {
  const row = await getLiveNote(vaultId, path)
  if (!row) return null
  const [revision] = await db
    .select({ id: noteRevisions.id, frontmatter: noteRevisions.frontmatter, body: noteRevisions.body })
    .from(noteRevisions)
    .where(and(eq(noteRevisions.id, revisionId), eq(noteRevisions.noteId, row.id), notInArray(noteRevisions.action, NOT_A_NOTE_STATE)))
  return revision ?? null
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

/** Restores a note to a recorded revision: a new attributed write, recorded
 * as a `revert` event naming that revision; earlier rows stay as they are (#479). */
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
    options: { revertOf: string },
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
  return updateFn(
    vaultId,
    path,
    { frontmatter: revision.frontmatter as Record<string, unknown>, body: revision.body },
    actor,
    { revertOf: revision.id },
  )

}

/**
 * Hard purge (spec 6): permanently removes one recorded revision — for
 * accidentally-committed secrets, where "recoverable" is the wrong
 * property. Owner/admin only — enforced by callers.
 */
export async function purgeRevision(vaultId: string, revisionId: string): Promise<boolean> {
  const [found] = (await db.execute(sql`
    SELECT r.seq = n.seq AS current FROM note_revisions r JOIN notes n ON n.id = r.note_id
    WHERE r.id = ${revisionId} AND n.vault_id = ${vaultId}`)) as unknown as Array<{ current: boolean | null }>
  if (!found) return false
  // ADR-003 §5.5: the note's text still holds what this revision holds (invariant I2).
  if (found.current) {
    throw new OkfValidationError('this revision is the note as it is now; edit the note first, then purge the revision')
  }
  await db.delete(noteRevisions).where(eq(noteRevisions.id, revisionId))
  return true
}

/**
 * Permanently removes a trashed note (used by purge policies later), under
 * its path's note lock (#484): one transaction deletes the row (revisions,
 * links and projection rows cascade) and its semantic edges, and queues the
 * removal of its files (`store_remove_file`, ADR-003 §5.5), which the
 * projector runs under the file ownership rules.
 */
export async function purgeNote(vaultId: string, noteId: string): Promise<boolean> {
  const purged = await withTrashedNote(vaultId, noteId, async (row) => {
    const done = await storeTransaction([row.id], async (tx) => {
      const locked = await lockedNote(tx, row.id)
      if (!locked || !locked.deletedAt) return false
      await tx.delete(notes).where(eq(notes.id, row.id))
      // semanticEdges is polymorphic and has no FK (spec 9), so it does not
      // cascade — clear it by hand or the rows leak (#92).
      await deleteSemanticEdgesFor('note', [row.id], tx)
      await insertStoreJob(tx, STORE_JOBS.removeFile, { vaultId, ownerId: row.id, paths: [`.trash/${row.id}.md`] })
      return true
    })
    if (!done) return false
    failpoint('purge.after-commit-before-remove')
    // The unchanged S2a relay still keys its CRDT state by path (ADR-003 §8 step 2e).
    await deleteCrdtState(vaultId, row.path).catch(() => {})
    wakeProjector()
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
