import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import * as Y from 'yjs'
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, ne, notInArray, or, sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { mcpConnections, noteLinks, noteRevisions, notes, semanticEdges } from '../db/schema.js'
import { recordJob } from '../monitoring/metrics.js'
import { INSTANCE_LOCK_KEY, writesPaused } from './maintenance-lock.js'
import { config } from '../config.js'
import { kickEmbeddings } from '../search/embedding-queue.js'
import { deleteSemanticEdgesFor } from '../search/semantic-edges.js'
import {
  closeNoteEditors,
  cloneDocument,
  compileChange,
  docState,
  liveDocumentOf,
  noteMoved,
  pushToLiveDocument,
  type DocState,
} from '../sync/live-docs.js'
import {
  appendGate,
  appendUpdate,
  compactNoteCrdt,
  storedStateOf,
  insertNoteCrdt,
  markFolded,
  notesNeedingFold,
  readNoteCrdt,
  rememberStoredState,
  seedDocument,
  setFoldError,
  type NoteCrdt,
  type UpdateActor,
} from '../sync/note-crdt.js'
import { mergeFrontmatter, mergeTextKeepingTheirs } from '../sync/three-way-merge.js'
import { revisionAtSeq } from './store-reconcile.js'
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
  BACKFILL_MARKER,
  NoteNotMigratedError,
  StoreBusyError,
  applyRowChange,
  collabNoteMigrated,
  enqueueEmbeddingTx,
  insertRevision,
  insertStoreJob,
  lockedNote,
  pgErrorCode,
  raiseProjections,
  replaceLinks,
  revisionBody,
  revisionColumns,
  storeTransaction,
  storedColumns,
  toStored,
  type StoredNote,
  type Tx,
} from './store-tx.js'
import { STORE_JOBS, registerRenameRefactor, wakeProjector, type RenameRefactorPayload } from './projector.js'
import { completeJob } from '../jobs/durable.js'
import { expandDependents, kickRevisionCompaction } from './revision-compaction.js'

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
 * recorded, dated and placed in the history (`ord`) at that read, only when
 * `write` returns a result: a refused or failed write leaves no restore
 * point. Unlike recordRevision it is kept even when the
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
  // The database's clock, as text, and the restore point's place in the
  // history, both taken before the write: the restore point lists before every
  // revision recorded after this read whatever the clock does (#825). A JS
  // Date would drop the microseconds of the time it shows.
  const [mark] = await db.execute<{ at: string; ord: string }>(
    sql`select clock_timestamp()::text as at, nextval(pg_get_serial_sequence('note_revisions', 'ord'))::text as ord`,
  )
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
      .select(revisionColumns)
      .from(noteRevisions)
      .where(and(eq(noteRevisions.noteId, row.id), notInArray(noteRevisions.action, NOT_A_NOTE_STATE)))
      .orderBy(desc(noteRevisions.ord))
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
    createdAt: sql`${mark!.at}::timestamptz`,
    ord: Number(mark!.ord),
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
        .select(revisionColumns)
        .from(noteRevisions)
        .where(eq(noteRevisions.noteId, row.id))
        .orderBy(desc(noteRevisions.ord))
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
      .set({ frontmatter, body: input.body, createdAt: sql`now()`, ord: sql`default` })
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
      body: revisionBody,
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
    .orderBy(desc(noteRevisions.ord))
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

/** A note row as writes and reads return it: the model's columns plus `seq`, the note's `rev` (#477). */
export type WrittenNote = NoteRow & { seq: number }

/** A row as callers see it: the model's columns and `seq` (`frontmatter_src` stays internal). */
function plainRow(row: StoredNote): WrittenNote {
  const plain: Partial<StoredNote> = { ...row }
  delete plain.frontmatterSrc
  // Only the internal field was removed: the rest is the model's row and seq.
  return plain as WrittenNote
}

/**
 * The relay's loaded document of a note (named by note id, ADR-003 §5.4, so
 * there is at most one), before a write (§5.2 step 3). `base` is a clone
 * taken now: `state` is what the write is computed from, and the editors'
 * typing the write appends to the log is exactly `base`'s delta over the
 * stored state, so the change compiled later is relative to what the write
 * saw. Typing that reaches the relay after the clone merges as a concurrent
 * edit when the change is pushed (step 8).
 */
interface Fold {
  /** The open document itself (whose cached stored state readNoteCrdt may use), and `base`, the clone taken now. */
  live: Y.Doc
  base: Y.Doc
  editors: string[]
  state: DocState
}

function foldSource(noteId: string, relayDoc?: Y.Doc): Fold | null {
  const live = liveDocumentOf(noteId)
  const doc = relayDoc ?? live?.doc
  if (!doc) return null
  const base = cloneDocument(doc)
  return { live: doc, base, editors: live?.editors ?? [], state: docState(base) }
}

function releaseFold(fold: Fold | null): void {
  fold?.base.destroy()
}

/**
 * Why the relay would refuse to store `state` over `row` (invalid, over the
 * size cap, a repeated block: #491, #492), or null. Such a state is never
 * written to the row on the editors' behalf, neither by a fold nor as the
 * body a write keeps; it stays in the CRDT log with `fold_error` set.
 */
function refusal(row: NoteRow, state: DocState): string | null {
  try {
    validateNote(row.type, row.name, { ...state.frontmatter, type: row.type } as Frontmatter, state.body)
    assertBodyFits(state.body, row.body)
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  return suspiciousWrite(row.body, state.body, 'repeated-block') === null ? null : 'the text repeats a block of the stored note (#492)'
}

/**
 * The body a write that does not change the body keeps: what the editors
 * see, unless the relay would refuse that state (then the stored body; the
 * editors keep their text, as the relay's own quarantine leaves it).
 */
export function keptBody(row: NoteRow, current: DocState): string {
  return current.body !== row.body && refusal(row, current) !== null ? row.body : current.body
}

/** A note after Invariant W's catch-up: its row, its CRDT state (null when it has none) and why the editors' state was not folded. */
interface CaughtUp {
  row: StoredNote
  crdt: NoteCrdt | null
  refused: string | null
  /** The rebase update applied to the CRDT state, to push into the loaded document. */
  rebased: Uint8Array | null
}

/**
 * Folds the CRDT state into the row (§5.4 fold steps 3-5): a state the row
 * already holds only advances `folded_through`; a state the relay would
 * refuse sets `fold_error` and leaves the row at its last valid version;
 * any other is written as a revision of `detail`'s kind.
 */
async function foldCrdt(tx: Tx, row: StoredNote, crdt: NoteCrdt, detail: Record<string, unknown>): Promise<CaughtUp> {
  const state = docState(crdt.doc)
  const frontmatter = { ...state.frontmatter, type: row.type } as Frontmatter
  if (state.body === row.body && sameContent(frontmatter, row.frontmatter as Record<string, unknown>)) {
    await markFolded(tx, crdt, row.seq)
    return { row, crdt, refused: null, rebased: null }
  }
  const refused = refusal(row, state)
  if (refused !== null) {
    await markFolded(tx, crdt, row.seq, { foldError: refused })
    return { row, crdt, refused, rebased: null }
  }
  const { row: folded } = await applyRowChange(
    tx,
    row,
    { frontmatter, body: state.body },
    { action: 'update', actor: SYSTEM_ACTOR, actorDetail: detail },
    { frontmatterOrder: orderKeys(row.frontmatterSrc, state.frontmatter) },
  )
  await markFolded(tx, crdt, folded.seq)
  failpoint('fold.before-commit')
  return { row: folded, crdt, refused: null, rebased: null }
}

/**
 * Rebase (§5.4 `rebaseLocked`): the row changed behind the store
 * (`notes.seq > folded_seq`: old code during a rollback, manual SQL, a
 * restore not converted yet). Base = the revision at `folded_seq`; theirs =
 * the row, first kept as a revision at its `seq`; ours = the CRDT state.
 * Non-overlapping changes from both sides are kept; on an overlap ours (the
 * editors' typing) stays and theirs is recoverable from its revision. The
 * merge is applied as a diff on top of the CRDT state (never a rebuild),
 * appended as a `rebase` update, then folded as a `merge` revision.
 */
async function rebaseLocked(tx: Tx, row: StoredNote, crdt: NoteCrdt): Promise<CaughtUp> {
  await revisionAtSeq(tx, row.id, 'out-of-band')
  const [base] = (await tx.execute(sql`
    SELECT frontmatter, note_revision_body(body, body_delta, delta_base_id) AS body FROM note_revisions WHERE note_id = ${row.id} AND seq = ${crdt.foldedSeq} LIMIT 1`)) as unknown as Array<{
    frontmatter: Record<string, unknown>
    body: string
  }>
  const ours = docState(crdt.doc)
  const theirs = { frontmatter: row.frontmatter as Record<string, unknown>, body: row.body }
  let merged: DocState = ours
  let conflict = ours.body !== theirs.body || !sameContent(ours.frontmatter, theirs.frontmatter)
  if (base) {
    const body = mergeTextKeepingTheirs(base.body, ours.body, theirs.body)
    const frontmatter = mergeFrontmatter(base.frontmatter as Record<string, unknown>, ours.frontmatter, theirs.frontmatter)
    merged = { frontmatter: frontmatter.frontmatter, body: body.text }
    conflict = body.overlaps.length > 0 || frontmatter.conflicts.length > 0
  }
  if (conflict) console.warn(`[collab] note ${row.id}: rebase kept the editors' text where the row changed behind the store too`)
  const update = compileChange(cloneDocument(crdt.doc), { frontmatter: { ...merged.frontmatter, type: row.type }, body: merged.body })
  const appended = await appendUpdate(tx, crdt, update, SYSTEM_ACTOR, { kind: 'rebase', conflict })
  const folded = await foldCrdt(tx, row, crdt, { kind: 'merge', conflict })
  return { ...folded, rebased: appended ? update : null }
}

/**
 * Invariant W, S2b (§5.2 step 3): before a write changes a note with CRDT
 * state, the row catches up with it: a rebase when the row changed behind
 * the store, then the loaded document's typing (`fold.base`'s delta over the
 * stored state) appended to the log, then (unless `storeRow` is false: the
 * relay's own store, which writes the row itself) the fold.
 */
async function catchUp(
  tx: Tx,
  row: StoredNote,
  crdt: NoteCrdt | null,
  fold: Fold | null,
  options: { storeRow: boolean },
): Promise<CaughtUp> {
  if (!crdt) return { row, crdt, refused: null, rebased: null }
  const rebase = row.seq > crdt.foldedSeq ? await rebaseLocked(tx, row, crdt) : null
  const current = rebase?.row ?? row
  if (fold) {
    // Over the stored state: its cached vector when `crdt.doc` is the open document's clone (readNoteCrdt).
    const typing = Y.encodeStateAsUpdate(fold.base, crdt.storedStateVector ?? Y.encodeStateVector(crdt.doc))
    await appendUpdate(tx, crdt, typing, SYSTEM_ACTOR, { kind: 'typing', editors: fold.editors })
    // The stored state now holds everything `crdt.doc` does.
    crdt.storedStateVector = null
  }
  const folded = options.storeRow
    ? await foldCrdt(tx, current, crdt, { kind: 'fold', editors: fold?.editors ?? [] })
    : { row: current, crdt, refused: null, rebased: null }
  return { ...folded, rebased: rebase?.rebased ?? null }
}

/**
 * §5.2 steps 5-6: the committed state compiled into one Yjs update on the
 * CRDT state (server process client id), appended with the write; the CRDT
 * state then agrees with the row at its new `seq`. `refused` (the editors'
 * state the row does not take, and the write left the body alone) keeps
 * the editors' text in the CRDT state and `fold_error` set. Returns the
 * update to push into the loaded document after commit.
 */
async function commitChange(
  tx: Tx,
  crdt: NoteCrdt,
  written: StoredNote,
  actor: Actor,
  detail: Record<string, unknown> | undefined,
  refused: string | null,
): Promise<Uint8Array | null> {
  const body = refused === null ? written.body : docState(crdt.doc).body
  const update = compileChange(cloneDocument(crdt.doc), { frontmatter: written.frontmatter as Record<string, unknown>, body })
  const appended = await appendUpdate(tx, crdt, update, actor, detail)
  await markFolded(tx, crdt, written.seq, { foldError: refused })
  return appended ? update : null
}

/** Wakes the workers that follow a commit: the projector (files, index.md) and the embedding worker. */
function afterCommit(): void {
  wakeProjector()
  kickEmbeddings()
  kickRevisionCompaction()
}

/** What createNote is asked for: `path`, or `type` and `name`. */
export interface NewNote {
  path?: string
  type?: string
  name?: string
  frontmatter?: Record<string, unknown>
  body?: string
}

/**
 * The note createNote would insert for `input`, validated (throws as createNote does).
 * `asImported` (rows-from-files, #495): the frontmatter is a file's, kept as given; no `timestamp` is added.
 */
function newNoteState(input: NewNote, asImported = false): { resolved: ResolvedNotePath; frontmatter: Frontmatter; body: string } {
  const rawPath =
    input.path ??
    (input.type && input.name
      ? `${input.type}/${input.name}`
      : `${input.type ?? ''}/${input.name ?? ''}`)
  const resolved = resolveNotePath(rawPath)
  const frontmatter: Frontmatter = {
    ...(asImported ? {} : { timestamp: new Date().toISOString() }),
    ...input.frontmatter,
    type: input.frontmatter?.type ? String(input.frontmatter.type) : resolved.type,
  }
  const body = input.body ?? ''
  validateNote(resolved.type, resolved.name, frontmatter, body)
  assertBodyFits(body)
  return { resolved, frontmatter, body }
}

/**
 * create_note `dry_run` (#477): the note createNote would create for
 * `input`, refused as createNote would refuse it (validation, size cap, a
 * live note at the path), with nothing written.
 */
export async function previewCreate(vaultId: string, input: NewNote): Promise<{ path: string; frontmatter: Frontmatter; body: string }> {
  const { resolved, frontmatter, body } = newNoteState(input)
  if (await getLiveNote(vaultId, resolved.fullPath)) throw new NoteExistsError(resolved.fullPath)
  return { path: resolved.fullPath, frontmatter, body }
}

export async function createNote(
  vaultId: string,
  input: NewNote,
  actor: Actor = SYSTEM_ACTOR,
  /** `asImported`: see newNoteState (rows-from-files only; not reachable from REST/MCP input). */
  options: Pick<WriteOptions, 'recordKey'> & { asImported?: boolean } = {},
): Promise<WrittenNote> {
  const { resolved, frontmatter, body } = newNoteState(input, options.asImported)
  return withKeyLock(noteLock(vaultId, resolved.fullPath), async () => {
    const id = randomUUID()
    let row: WrittenNote
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
        // Written by the store: nothing for the S2a backfill to do.
        await tx.execute(sql`INSERT INTO note_projections (note_id, projection, target_seq, applied_seq) VALUES (${id}, ${BACKFILL_MARKER}, 1, 1)`)
        await enqueueEmbeddingTx(tx, id, 1)
        const created = { ...inserted!, seq: 1 }
        await options.recordKey?.(tx, created)
        return created
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
  options: Pick<WriteOptions, 'recordKey'> = {},
): Promise<WrittenNote | null> {
  if (await getLiveNote(vaultId, input.path)) return null
  try {
    return await createNote(vaultId, input, actor, options)
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

/** A note as a read serves it: the row (with `seq`, its `rev`) and the frontmatter in the key order of its file. */
export interface ReadNote {
  row: WrittenNote
  frontmatter: Frontmatter
  body: string
  /** readLiveNote: the editors' state was not folded, because the relay would refuse to store it (#491, #492). */
  foldError?: string
}

/**
 * Reads a live note from the database, the only authority (ADR-003 §6):
 * the row, with its frontmatter in the key order of its file
 * (`frontmatter_src`). The `.md` file is a projection and is never read
 * back, so a note whose file is missing, damaged or not yet written reads
 * the same as any other. Typing the relay has not stored yet is not in it:
 * readers that serve a note to an agent or a person use readLiveNote.
 */
export async function readNote(vaultId: string, path: string): Promise<ReadNote | null> {
  const row = await readStored(vaultId, resolveNotePath(path).fullPath)
  return row ? presented(row) : null
}

function presented(row: StoredNote, foldError?: string): ReadNote {
  return {
    row: plainRow(row),
    frontmatter: presentedFrontmatter(row.frontmatter, row.frontmatterSrc) as Frontmatter,
    body: row.body,
    ...(foldError ? { foldError } : {}),
  }
}

/**
 * Reads a live note as its editors see it (#474, ADR-003 §6 fold on read):
 * when the relay has the note's document loaded, Invariant W's catch-up runs
 * first under the note's lock (a row changed behind the store is rebased,
 * the editors' typing is appended to the CRDT log and folded; one revision
 * per fold, Q8), and the row is served after. The text returned is
 * therefore exactly the revision at `row.seq`, the `rev` a later `base_rev`
 * names, and holds everything the relay has. A note with no loaded
 * document is read without a lock or a write. A state the relay would
 * refuse to store (#491, #492) is not folded: the last valid row is served
 * with `foldError` (also set on `note_crdt`). When the store cannot take the
 * fold (lock timeout, maintenance), the read fails with NoteReadBusyError
 * (HTTP 503): it would otherwise serve text without the typing.
 *
 * Never call it while holding the note's lock (the relay's load hook does):
 * key-lock.ts is not reentrant.
 */
export async function readLiveNote(vaultId: string, path: string): Promise<ReadNote | null> {
  const resolved = resolveNotePath(path)
  const seen = await readStored(vaultId, resolved.fullPath)
  if (!seen) return null
  // S3: acked typing is in note_updates even when no editor has the note open (a tab closed before its store, a crash).
  // A note whose S2b backfill or roll-forward failed at this boot takes no fold until a restart merges its bin
  // (collabNoteMigrated): its stored row is what can be read, and a fold attempt could never succeed.
  if (!collabNoteMigrated(seen.id) || (!liveDocumentOf(seen.id) && !(await foldPending(seen.id)))) return presented(seen)
  return withKeyLock(noteLock(vaultId, resolved.fullPath), async () => {
    const row = await readStored(vaultId, resolved.fullPath)
    if (!row) return null
    const fold = foldSource(row.id)
    try {
      let folded
      try {
        folded = await storeTransaction([row.id], async (tx) => {
          const locked = await lockedNote(tx, row.id)
          if (!locked || locked.deletedAt || locked.path !== resolved.fullPath) return null
          return catchUp(tx, locked, await readNoteCrdt(tx, locked.id), fold, { storeRow: true })
        })
      } catch (err) {
        if (err instanceof StoreBusyError) throw new NoteReadBusyError()
        throw err
      }
      if (!folded) return readNote(vaultId, resolved.fullPath)
      pushToLiveDocument(row.id, folded.rebased)
      if (folded.row.seq !== row.seq) afterCommit()
      return presented(
        folded.row,
        folded.refused ? 'the open editors hold a state the store refuses (invalid, over the size cap, or a repeated block); this is the last valid version' : undefined,
      )
    } finally {
      releaseFold(fold)
    }
  })
}

/** Whether note `noteId` has CRDT work a read must fold first (§6): an unfolded, non-rejected tail, or a row past `folded_seq`. */
async function foldPending(noteId: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT 1 FROM note_crdt c JOIN notes n ON n.id = c.note_id
    WHERE c.note_id = ${noteId}
      AND (n.seq > c.folded_seq OR EXISTS (SELECT 1 FROM note_updates u
        WHERE u.note_id = c.note_id AND u.id > c.folded_through AND u.rejected_at IS NULL))`)) as unknown as unknown[]
  return rows.length > 0
}

/** readLiveNote could not store the open editors' typing first (the store is busy): nothing was read. HTTP 503. */
export class NoteReadBusyError extends StoreBusyError {
  constructor() {
    super('read')
    this.message =
      'the note is open in an editor and its unsaved typing could not be saved before the read, because the note store is busy; retry the read'
  }
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
   * loaded (`noteId`, the store goes nowhere else) and the document. Its
   * typing is appended to the CRDT log and the write itself stores it, so
   * nothing is folded first.
   */
  relay?: { noteId: string; doc: Y.Doc }
  /** `dry_run` (#477): compute the next state and return it as the row would be, without writing anything. */
  dryRun?: boolean
  /** Receives the state the write changed (what the editors saw, else the row): the base of its `diff_stats` (#477). */
  outcome?: WriteOutcome
  /** The call's idempotency key (#477), recorded inside the write's transaction: see RecordKey. */
  recordKey?: RecordKey
}

/**
 * Runs inside a write's transaction, after its change, with the row the
 * transaction commits (#477): the MCP layer records the call's
 * `idempotency_key` and answer there, so a write that commits always has
 * its key, also when the process dies before the answer (ADR-003 §4, §10).
 */
export type RecordKey = (tx: Tx, row: WrittenNote) => Promise<void>

/** What writeNote reports besides the row (#477). */
export interface WriteOutcome {
  before?: { frontmatter: Record<string, unknown>; body: string }
}

/** Times a write recomputes when another process changed the note between its read and its lock. */
const WRITE_ROUNDS = 3

/**
 * One server write to the live note at `path` (ADR-003 §5.2, Invariant W),
 * under the note's lock:
 * 1. a dry run computes against the relay's loaded document if there is one
 *    (what the editors see), else the row, and stops there;
 * 2. one transaction: the instance and note locks, the row again (FOR NO
 *    KEY UPDATE, so a relay append's foreign-key check never waits for it;
 *    a row another process changed meanwhile recomputes; a row changed
 *    behind the store is rebased into the CRDT state first, then the write
 *    recomputes), the CRDT state (snapshot ⊕ every update committed before
 *    the tail read, which every acked collab update is) folded, then
 *    `compute` turns that state into the next one and refuses by throwing
 *    (validation, size cap, quarantine, overlap), then the write: row,
 *    revision at the new `seq`, links, projection targets, embedding job,
 *    and (for a note with CRDT state) the change as one Yjs update relative
 *    to exactly the state `compute` saw; COMMIT is the ack. Collab updates
 *    appended meanwhile (S3: appends do not wait for this transaction) stay
 *    in the log past `folded_through` and merge as concurrent edits;
 * 3. that update applied to the loaded document; the projector woken.
 * Null when no live note is at `path` (or it is not `options.relay.noteId`).
 */
export async function writeNote(
  vaultId: string,
  path: string,
  compute: (current: { frontmatter: Record<string, unknown>; body: string }, row: NoteRow) => Promise<NextState> | NextState,
  actor: Actor,
  options: WriteOptions = {},
): Promise<WrittenNote | null> {
  const resolved = resolveNotePath(path)
  return withKeyLock(noteLock(vaultId, resolved.fullPath), async () => {
    for (let round = 0; round < WRITE_ROUNDS; round++) {
      const seen = await readStored(vaultId, resolved.fullPath)
      if (!seen || (options.relay && seen.id !== options.relay.noteId)) return null
      const fold = foldSource(seen.id, options.relay?.doc)
      if (options.dryRun) {
        try {
          const current = fold?.state ?? { frontmatter: seen.frontmatter as Record<string, unknown>, body: seen.body }
          const next = await compute(current, plainRow(seen))
          if (options.outcome) options.outcome.before = current
          return { ...plainRow(seen), frontmatter: { ...next.frontmatter, type: seen.type }, body: next.body }
        } finally {
          releaseFold(fold)
        }
      }
      let committed
      try {
        committed = await storeTransaction([seen.id], async (tx) => {
          const locked = await lockedNote(tx, seen.id)
          if (!locked || locked.deletedAt || locked.path !== resolved.fullPath) return null
          if (locked.seq !== seen.seq) return 'moved' as const
          // With the open document in hand, its cached stored state spares materialising snapshot ⊕ tail.
          const crdt = await readNoteCrdt(tx, locked.id, fold ? { live: fold.live, base: fold.base, seq: locked.seq } : undefined)
          // The row changed behind the store: merged into the CRDT state, then this write is computed again.
          if (crdt && locked.seq > crdt.foldedSeq) return { rebased: (await rebaseLocked(tx, locked, crdt)).rebased }
          const { row, refused } = await catchUp(tx, locked, crdt, fold, { storeRow: !options.relay })
          const current = crdt ? docState(crdt.doc) : { frontmatter: row.frontmatter as Record<string, unknown>, body: row.body }
          const next = await compute(current, plainRow(row))
          if (options.outcome) options.outcome.before = current
          const { row: written } = await applyRowChange(
            tx,
            row,
            { frontmatter: { ...next.frontmatter, type: row.type }, body: next.body },
            options.revertOf
              ? { action: 'revert', actor, sourceRevisionId: options.revertOf, actorDetail: options.actorDetail }
              : { action: 'update', actor, actorDetail: options.actorDetail },
          )
          const keepLiveBody = refused !== null && written.body === locked.body
          const update = crdt ? await commitChange(tx, crdt, written, actor, options.actorDetail, keepLiveBody ? refused : null) : null
          await options.recordKey?.(tx, plainRow(written))
          failpoint('edit.before-commit')
          return { written, update, stored: crdt && fold ? storedStateOf(crdt) : null }
        })
      } finally {
        releaseFold(fold)
      }
      if (committed === 'moved') continue
      if (!committed) return null
      if ('rebased' in committed) {
        pushToLiveDocument(seen.id, committed.rebased ?? null)
        continue
      }
      failpoint('edit.after-commit-before-live-apply')
      pushToLiveDocument(seen.id, committed.update)
      // The open document now holds what was committed (its typing was appended, the update pushed).
      if (fold) rememberStoredState(fold.live, committed.stored)
      afterCommit()
      failpoint('edit.after-commit-before-ack')
      return plainRow(committed.written)
    }
    throw new StoreBusyError('the note kept changing')
  })
}

/**
 * Writes `input` to the live note at `path` (writeNote): a field left out
 * keeps its current value (a body the relay would refuse is not kept, see
 * keptBody), a `body` function (BodyEdit) gets the current body. `input`
 * may be a function of the current state, called under the note's lock:
 * the relay's store passes one that returns its document's state as the
 * write sees it, so the row gets exactly the typing the write appends.
 * `options.quarantine` checks the body against the stored one first
 * (refuseSuspiciousWrite; the collab relay's store passes the quarantine
 * revision of the loaded document's episode, if any).
 */
export async function updateNote(
  vaultId: string,
  path: string,
  input: NoteInput | ((current: DocState) => NoteInput),
  actor: Actor = SYSTEM_ACTOR,
  options: WriteOptions & { quarantine?: QuarantineRules; episode?: string } = {},
): Promise<WrittenNote | null> {
  return writeNote(
    vaultId,
    path,
    async (current, row) => {
      const edit = typeof input === 'function' ? input(current) : input
      const body = typeof edit.body === 'function' ? edit.body(current.body) : (edit.body ?? keptBody(row, current))
      const frontmatter: Frontmatter = { ...(edit.frontmatter ?? current.frontmatter), type: row.type }
      validateNote(row.type, row.name, frontmatter, body)
      // The size cap first: an over-cap body is refused, never kept as a quarantine revision (#491).
      assertBodyFits(body, row.body)
      if (options.quarantine) {
        await refuseSuspiciousWrite(row, { frontmatter: edit.frontmatter, body }, actor, options.quarantine, options.episode)
      }
      return { frontmatter, body }
    },
    actor,
    options,
  )
}

/** A write's new frontmatter and body; a field left out keeps its value. */
export interface NoteInput {
  frontmatter?: Record<string, unknown>
  body?: BodyEdit
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
) => Promise<WrittenNote | null>

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
  options: Pick<WriteOptions, 'recordKey'> = {},
): Promise<WrittenNote | null> {
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
    () => moveNote(vaultId, fromResolved, toResolved, renaming, actor, options.recordKey),
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
  recordKey: RecordKey | undefined,
): Promise<{ updated: WrittenNote; referrers: string[]; job: number | null } | null> {
  const seen = await readStored(vaultId, fromResolved.fullPath)
  if (!seen) return null
  if (toResolved.fullPath !== fromResolved.fullPath && (await getLiveNote(vaultId, toResolved.fullPath))) {
    throw new OkfValidationError(`a note already exists at ${toResolved.fullPath}`)
  }
  const isMoving = fromResolved.fullPath !== toResolved.fullPath
  const fold = foldSource(seen.id)
  let result: { updated: StoredNote; referrers: string[]; job: number | null; update: Uint8Array | null; rebased: Uint8Array | null } | null
  try {
    result = await storeTransaction([seen.id], async (tx) => {
      const locked = await lockedNote(tx, seen.id)
      if (!locked || locked.deletedAt || locked.path !== fromResolved.fullPath) return null
      const crdt = await readNoteCrdt(tx, locked.id)
      const { row, refused, rebased } = await catchUp(tx, locked, crdt, fold, { storeRow: true })
      // Self-referential wikilinks in the note's own body follow it. The row
      // holds the editors' typing now, unless the relay would refuse it.
      const newBody = isMoving ? refactorWikilinks(row.body, fromResolved.fullPath, toResolved.fullPath) : row.body
      const newFrontmatter: Frontmatter = { ...(row.frontmatter as Record<string, unknown>), type: toResolved.type }
      validateNote(toResolved.type, toResolved.name, newFrontmatter, newBody)
      // #491: rewriting links can grow a body past the size cap. Every rewritten
      // body (the note's own, then each referrer's) is checked before anything is
      // written, so a refused rename leaves the vault as it was.
      assertBodyFits(newBody, row.body, `${renaming} rewrites its own links`)
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
      // The body and `type` change, compiled into the CRDT state (§5.5): the document keeps its name, so editors stay connected.
      const keepLiveBody = refused !== null && updated.body === locked.body
      const update = crdt ? await commitChange(tx, crdt, updated, actor, undefined, keepLiveBody ? refused : null) : null
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
      await recordKey?.(tx, plainRow(updated))
      return { updated, referrers: referrers.map((r) => r.id), job, update, rebased }
    })
  } catch (err) {
    if (isUniqueViolation(err)) throw new OkfValidationError(`a note already exists at ${toResolved.fullPath}`)
    throw err
  } finally {
    releaseFold(fold)
  }
  if (!result) return null
  pushToLiveDocument(seen.id, result.rebased)
  pushToLiveDocument(seen.id, result.update)
  if (isMoving) noteMoved(seen.id, vaultId, fromResolved.fullPath, toResolved.fullPath)
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
  options: Pick<WriteOptions, 'recordKey'> = {},
): Promise<WrittenNote | null> {
  const resolved = resolveNotePath(path)
  return withKeyLock(noteLock(vaultId, resolved.fullPath), async () => {
    const seen = await readStored(vaultId, resolved.fullPath)
    if (!seen) return null
    const fold = foldSource(seen.id)
    try {
      const deleted = await storeTransaction([seen.id], async (tx) => {
        const locked = await lockedNote(tx, seen.id)
        if (!locked || locked.deletedAt || locked.path !== resolved.fullPath) return null
        const { row, rebased } = await catchUp(tx, locked, await readNoteCrdt(tx, locked.id), fold, { storeRow: true })
        const deleted = (await applyRowChange(tx, row, { deletedAt: new Date() }, { action: 'delete', actor })).row
        await options.recordKey?.(tx, plainRow(deleted))
        return { row: deleted, rebased }
      })
      if (!deleted) return null
      pushToLiveDocument(seen.id, deleted.rebased)
      // §5.5: the note's editors are closed now (`note-deleted`); a reconnect is refused until a restore.
      closeNoteEditors(seen.id)
      afterCommit()
      return plainRow(deleted.row)
    } finally {
      releaseFold(fold)
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
  options: Pick<WriteOptions, 'recordKey'> = {},
): Promise<WrittenNote | null> {
  return withTrashedNote(vaultId, noteId, async (seen) => {
    if (await getLiveNote(vaultId, seen.path)) {
      throw new OkfValidationError(`a live note already exists at ${seen.path}`)
    }
    let restored: StoredNote | null
    try {
      restored = await storeTransaction([seen.id], async (tx) => {
        const locked = await lockedNote(tx, seen.id)
        if (!locked || !locked.deletedAt) return null
        const restored = (await applyRowChange(tx, locked, { deletedAt: null }, { action: 'restore', actor })).row
        await options.recordKey?.(tx, plainRow(restored))
        return restored
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

/** The note fields `browse_vault` can return (#425), in the order it shows them: never the body, the whole frontmatter or the embedding. */
export const BROWSE_FIELDS = ['id', 'path', 'title', 'type', 'name', 'tags', 'updatedAt'] as const
export type BrowseField = (typeof BROWSE_FIELDS)[number]

/** A note as `browse_vault` lists it (#425): its title is `frontmatter.title` (an empty one too: its name); never the body or the embedding. */
export interface BrowsedNote {
  id: string
  path: string
  title: string
  type: string
  name: string
  tags: unknown
  updatedAt: Date
}

const browsedNote = {
  id: notes.id,
  path: notes.path,
  title: sql<string>`coalesce(nullif(${notes.frontmatter}->>'title', ''), ${notes.name})`,
  type: notes.type,
  name: notes.name,
  tags: sql<unknown>`${notes.frontmatter}->'tags'`,
  updatedAt: notes.updatedAt,
}

/** A path in code-unit order, as `notes_vault_path_c_live` (migration 0030) holds it. */
const pathC = sql`${notes.path} collate "C"`

/**
 * The folder a note is in with its trailing '/' ('' at the root), as
 * `notes_vault_dir_c_live` (migration 0030) holds it: the expression must
 * stay as written there, with the pattern inline, for the index to serve it.
 */
const dirC = sql`coalesce(substring(${notes.path} from '^(.*/)'), '') collate "C"`

const live = (vaultId: string) => sql`${notes.vaultId} = ${vaultId} and ${notes.deletedAt} is null`

/** The folder's path with its trailing '/' ('' at the root), and what every path under it sorts below (none at the root): '0' is the code unit after '/'. */
const folderRange = (folder: string) => ({ prefix: folder ? `${folder}/` : '', below: folder ? `${folder}0` : null })

/**
 * One page of `browse_vault`'s notes (#425), in path order by code unit,
 * whose path sorts after `after`, at most `limit`: the notes directly in
 * `folder` (`''`: the root), one range of `notes_vault_dir_c_live`, or with
 * `recursive` every note under it, one range of `notes_vault_path_c_live`
 * (`folder/` ≤ path < `folder0`, no LIKE escaping). REST's `listNotes`
 * (tree, audit, export) stays whole.
 */
export async function browseNotesPage(
  vaultId: string,
  opts: { folder: string; recursive: boolean; after: string | null; limit: number },
): Promise<BrowsedNote[]> {
  const { prefix, below } = folderRange(opts.folder)
  const where: SQL[] = [live(vaultId)]
  if (!opts.recursive) where.push(sql`${dirC} = ${prefix}`)
  else if (below !== null) where.push(sql`${pathC} >= ${prefix}`, sql`${pathC} < ${below}`)
  if (opts.after !== null) where.push(sql`${pathC} > ${opts.after}`)
  return db.select(browsedNote).from(notes).where(and(...where)).orderBy(pathC).limit(opts.limit)
}

/**
 * One page of the subfolders directly in `folder` (`''`: the root) for
 * `browse_vault` (#425), after the subfolder `after`, at most `limit`, each
 * with the number of live notes under it (at any depth). They come in the
 * order of their paths with the trailing '/' (`docs-old/` before `docs/`),
 * which is the order of `notes_vault_dir_c_live`: each subfolder is one probe
 * of that index from the end of the one before (a skip scan), and its count
 * one range of `notes_vault_path_c_live`. Neither the notes directly in
 * `folder` nor the subfolders past the page are read.
 */
export async function browseSubfoldersPage(
  vaultId: string,
  opts: { folder: string; after: string | null; limit: number },
): Promise<Array<{ name: string; count: number }>> {
  const { prefix, below } = folderRange(opts.folder)
  const inFolder = below === null ? sql`` : sql` and ${dirC} < ${below}`
  // A subfolder's name is the first segment of a folder below `prefix`; the next one starts at or after `prefix` + name + '0'.
  const nameOf = (d: SQL) => sql`split_part(substr(${d}, char_length(${prefix}::text) + 1), '/', 1)`
  const first = opts.after === null ? sql`${dirC} > ${prefix}` : sql`${dirC} >= ${`${prefix}${opts.after}0`}`
  const rows = (await db.execute(sql`
    WITH RECURSIVE sub(d) AS (
      (SELECT ${dirC} FROM ${notes} WHERE ${live(vaultId)} AND ${first}${inFolder} ORDER BY ${dirC} LIMIT 1)
      UNION ALL
      SELECT (
        SELECT ${dirC} FROM ${notes}
        WHERE ${live(vaultId)} AND ${dirC} >= ${prefix}::text || ${nameOf(sql`sub.d`)} || '0'${inFolder}
        ORDER BY ${dirC} LIMIT 1
      ) FROM sub WHERE sub.d IS NOT NULL
    )
    SELECT page.name, (
      SELECT count(*)::int FROM ${notes}
      WHERE ${live(vaultId)} AND ${pathC} >= ${prefix}::text || page.name || '/' AND ${pathC} < ${prefix}::text || page.name || '0'
    ) AS count
    FROM (SELECT ${nameOf(sql`d`)} AS name FROM sub WHERE d IS NOT NULL LIMIT ${opts.limit}) AS page`)) as unknown as Array<{
    name: string
    count: number
  }>
  return rows.map(({ name, count }) => ({ name, count }))
}

/** The live notes under `folder` with what `renderDirIndex` reads, for `browse_vault`'s generated `indexContent` (#425). */
export async function folderIndexRows(
  vaultId: string,
  folder: string,
): Promise<Array<{ path: string; type: string; frontmatter: Record<string, unknown> }>> {
  const { prefix, below } = folderRange(folder)
  const where: SQL[] = [live(vaultId)]
  if (below !== null) where.push(sql`${pathC} >= ${prefix}`, sql`${pathC} < ${below}`)
  return db
    .select({ path: notes.path, type: notes.type, frontmatter: sql<Record<string, unknown>>`${notes.frontmatter}` })
    .from(notes)
    .where(and(...where))
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
export type RevisionDetail = Omit<RevisionRow, keyof RevisionEventDetail | 'ord'> & RevisionEventDetail & { path: string }

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
 * Where a history page ends: the last revision's `ord`, its place in the
 * order revisions were recorded in (#825; `created_at` can step back or tie).
 */
export interface RevisionPosition {
  ord: number
}

/**
 * One page of a note's change history, newest first, metadata only (#411):
 * the bodies are never read (`octet_length` takes the size from the stored
 * value's header; a compacted revision's size is its `body_bytes`, #501).
 * Keyset-paged on `ord` after `before`, so a revision
 * recorded while a caller pages does not shift the pages. `ords` are the
 * revisions' positions (a page can stop after any of them), `next` the
 * position to continue from, or null on the last page. Null when the note
 * does not exist. Edit/owner only — enforced by callers.
 */
export async function listRevisionPage(
  vaultId: string,
  path: string,
  limit: number,
  before?: RevisionPosition,
): Promise<{ revisions: RevisionSummary[]; ords: number[]; next: RevisionPosition | null } | null> {
  const row = await getLiveNote(vaultId, path)
  if (!row) return null
  const rows = await db
    .select({
      id: noteRevisions.id,
      actorType: noteRevisions.actorType,
      actorId: noteRevisions.actorId,
      action: noteRevisions.action,
      createdAt: noteRevisions.createdAt,
      bodyBytes: sql<number>`coalesce(${noteRevisions}.body_bytes, octet_length(${noteRevisions.body}))`,
      ...eventColumns,
      ord: noteRevisions.ord,
    })
    .from(noteRevisions)
    .where(and(eq(noteRevisions.noteId, row.id), before ? lt(noteRevisions.ord, before.ord) : undefined))
    .orderBy(desc(noteRevisions.ord))
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
    ords: page.map((r) => r.ord),
    next: rows.length > limit && last ? { ord: last.ord } : null,
  }
}

/** Revision metadata only — never a note's content — newest first (in the
 * order recorded, #825), always bounded (perf rule 3: no unbounded reads).
 * The REST history list. */
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
    .orderBy(desc(noteRevisions.ord))
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
      body: revisionBody,
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
 * The revision an edit says it was made from (edit_note `base_rev`, #475):
 * a revision of the live note at `path` that held its content, named by the
 * note's `seq` at that state (the `rev` reads and writes return, #477) or by
 * its id (the `rev` before #477, and note_history ids, #822). Null when there
 * is no such note or no such state of it.
 */
export async function getBaseRevision(
  vaultId: string,
  path: string,
  rev: string | number,
): Promise<Pick<RevisionRow, 'id' | 'frontmatter' | 'body'> | null> {
  const row = await getLiveNote(vaultId, path)
  if (!row) return null
  // `note_revisions.seq` (0021) is not in the Drizzle model.
  const named =
    typeof rev === 'number' ? sql`note_revisions.seq = ${rev}` : UUID_PATTERN.test(rev) ? eq(noteRevisions.id, rev) : null
  if (!named) return null
  const [revision] = await db
    .select({ id: noteRevisions.id, frontmatter: noteRevisions.frontmatter, body: revisionBody })
    .from(noteRevisions)
    .where(and(named, eq(noteRevisions.noteId, row.id), notInArray(noteRevisions.action, NOT_A_NOTE_STATE)))
  return revision ?? null
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Whether note `noteId` at `seq` is fully indexed (#477 `indexed`): its
 * `file` and `dir_index` projections are applied at `seq` or later, and the
 * embedding job of `seq`, if one was queued, is done. False right after a
 * write: the projector and the embedding worker run after the commit.
 */
export async function noteIndexed(noteId: string, seq: number): Promise<boolean> {
  const [found] = (await db.execute(sql`
    SELECT NOT EXISTS (
        SELECT 1 FROM note_projections
        WHERE note_id = ${noteId} AND projection IN ('file', 'dir_index') AND applied_seq < ${seq}
      ) AND NOT EXISTS (
        SELECT 1 FROM jobs WHERE idempotency_key = ${`embed_note:${noteId}:${seq}`} AND done_at IS NULL
      ) AS indexed`)) as unknown as Array<{ indexed: boolean }>
  return found?.indexed === true
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
    options: { revertOf: string } & Pick<WriteOptions, 'dryRun' | 'outcome' | 'recordKey'>,
  ) => Promise<WrittenNote | null> = updateNote,
  options: Pick<WriteOptions, 'dryRun' | 'outcome' | 'recordKey'> = {},
): Promise<WrittenNote | null> {
  const row = await getLiveNote(vaultId, path)
  if (!row) return null
  const revision = (
    await db
      .select(revisionColumns)
      .from(noteRevisions)
      .where(and(eq(noteRevisions.id, revisionId), eq(noteRevisions.noteId, row.id)))
  )[0]
  if (!revision) return null
  return updateFn(
    vaultId,
    path,
    { frontmatter: revision.frontmatter as Record<string, unknown>, body: revision.body },
    actor,
    { ...options, revertOf: revision.id },
  )
}

/**
 * Hard purge (spec 6): permanently removes one recorded revision — for
 * accidentally-committed secrets, where "recoverable" is the wrong
 * property. Owner/admin only — enforced by callers. Refused for the
 * revision at the note's `seq` (its text still holds it) and for the
 * rebase base (the revision at `note_crdt.folded_seq` while the row is
 * past it). One store transaction under the note's lock: the revisions
 * stored as a delta from this one (#501) are stored whole again first, so
 * none loses its base, and the note's CRDT state is compacted: only a
 * re-encoded snapshot drops deleted text (ADR-003 §5.4, §5.5).
 */
export async function purgeRevision(vaultId: string, revisionId: string): Promise<boolean> {
  const [found] = (await db.execute(sql`
    SELECT r.note_id, r.seq = n.seq AS current,
      (c.folded_seq IS NOT NULL AND r.seq = c.folded_seq AND n.seq > c.folded_seq) AS base
    FROM note_revisions r JOIN notes n ON n.id = r.note_id LEFT JOIN note_crdt c ON c.note_id = n.id
    WHERE r.id = ${revisionId} AND n.vault_id = ${vaultId}`)) as unknown as Array<{ note_id: string; current: boolean | null; base: boolean }>
  if (!found) return false
  // ADR-003 §5.5: the note's text still holds what this revision holds (invariant I2).
  if (found.current) {
    throw new OkfValidationError('this revision is the note as it is now; edit the note first, then purge the revision')
  }
  if (found.base) {
    throw new OkfValidationError('this revision is the base of a pending merge of the note; open or edit the note first, then purge the revision')
  }
  await storeTransaction([found.note_id], async (tx) => {
    await expandDependents(tx, revisionId)
    await tx.delete(noteRevisions).where(eq(noteRevisions.id, revisionId))
    const crdt = await readNoteCrdt(tx, found.note_id)
    if (crdt) await compactNoteCrdt(tx, crdt)
  })
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
      // The delete's dir_index projection cascades away with the row: the folders are queued here.
      await insertStoreJob(tx, STORE_JOBS.dirIndex, { vaultId, dirs: resolveNotePath(row.path).ancestorDirectories })
      return true
    })
    if (!done) return false
    failpoint('purge.after-commit-before-remove')
    closeNoteEditors(row.id)
    wakeProjector()
    return true
  })
  return purged ?? false
}

/**
 * The relay's load of note `noteId`'s document (ADR-003 §5.4 "Load"), under
 * the note's locks: the note's CRDT state, seeded deterministically in the
 * same transaction when it has none; a row changed behind the store is
 * rebased into it and folded first, and so is a tail left unfolded. Never
 * reads a file or a `.crdt` bin, and never rebuilds the text (#488).
 * Returns the state to apply to the document, the note's path, the last
 * update id that state includes (null while `fold_error` is set: the open
 * document then caches nothing, see note-crdt.ts readNoteCrdt), and that
 * `fold_error` (the relay tells the editors of a quarantine it names, #784).
 */
export async function loadCollabState(
  vaultId: string,
  noteId: string,
): Promise<{ state: Uint8Array; path: string; lastId: number | null; foldError: string | null }> {
  for (let round = 0; round < WRITE_ROUNDS; round++) {
    const [note] = await db
      .select({ path: notes.path })
      .from(notes)
      .where(and(eq(notes.id, noteId), eq(notes.vaultId, vaultId), isNull(notes.deletedAt)))
    if (!note) throw new Error(`note does not exist: ${vaultId}/~${noteId}`)
    let foldedRow = false
    const loaded = await withKeyLock(noteLock(vaultId, note.path), () =>
      storeTransaction([noteId], async (tx) => {
        const locked = await lockedNote(tx, noteId)
        if (!locked || locked.deletedAt || locked.vaultId !== vaultId) throw new Error(`note does not exist: ${vaultId}/~${noteId}`)
        if (locked.path !== note.path) return null
        const stored = await readNoteCrdt(tx, noteId)
        if (stored) {
          const { row } = await catchUp(tx, locked, stored, null, { storeRow: true })
          if (row.seq !== locked.seq) foldedRow = true
          return { state: Y.encodeStateAsUpdate(stored.doc), lastId: stored.foldError === null ? stored.lastId : null, foldError: stored.foldError }
        }
        const seed = seedDocument(noteId, { frontmatter: locked.frontmatter as Record<string, unknown>, body: locked.body })
        await insertNoteCrdt(tx, noteId, seed, locked.seq)
        return { state: Y.encodeStateAsUpdate(seed), lastId: 0, foldError: null }
      }),
    )
    // A fold that stored the row wakes the projector, so the file follows at once, not at its next poll.
    if (foldedRow) afterCommit()
    if (loaded) return { ...loaded, path: note.path }
  }
  throw new StoreBusyError('the note kept moving')
}

/**
 * Logs a collab update the relay checked (§5.4 "Append", S3) before the
 * relay applies and acks it. Appends of one note are group-committed (ADR
 * Q7): those that arrive while a commit is running wait for it and then go
 * together, in arrival order, in one statement (the instance check, the
 * note re-checked live, one multi-row INSERT; see commitAppends), so the
 * commit rate never caps the typing rate. The statement takes neither
 * the note's queue lock nor its advisory lock, so a fold or a write holding
 * them never delays an ack; it holds the note's append gate (appendGate)
 * from its ids to its COMMIT instead, which is what lets a fold stop at a
 * boundary no later append falls under. Resolves to the row id (and the id
 * before it), or null when the note is trashed or purged (nothing stored;
 * the relay refuses the update). A throw (Postgres down, a lock timeout,
 * maintenance, too many waiting) leaves nothing stored either; the relay
 * then closes the connection unacked and the editor resends.
 */
export function appendCollabUpdate(vaultId: string, noteId: string, update: Uint8Array, actor: UpdateActor): Promise<LoggedUpdate | null> {
  let queue = appendQueues.get(noteId)
  if (!queue) {
    queue = { waiting: [], inFlight: 0, running: false }
    appendQueues.set(noteId, queue)
  }
  // Backpressure: past the bound the relay closes the socket unacked (retryable) instead of queueing without end.
  if (queue.waiting.length + queue.inFlight >= MAX_PENDING_APPENDS) return Promise.reject(new StoreBusyError('too many collab updates are waiting for this note'))
  const waiting = queue
  const promise = new Promise<LoggedUpdate | null>((resolve, reject) => waiting.waiting.push({ vaultId, update, actor, resolve, reject }))
  if (!queue.running) void drainAppends(noteId, queue)
  return promise
}

interface PendingAppend {
  vaultId: string
  update: Uint8Array
  actor: UpdateActor
  resolve: (logged: LoggedUpdate | null) => void
  reject: (err: unknown) => void
}

/** Per note: the collab appends waiting for the next group commit, those in the running one, and whether one is running. */
interface AppendQueue {
  waiting: PendingAppend[]
  inFlight: number
  running: boolean
}
const appendQueues = new Map<string, AppendQueue>()
const MAX_PENDING_APPENDS = 256

/** A logged collab update: its id, and the note's previous stored id (its last non-rejected update, or `snapshot_through` after a compaction): what an open document's cached state must be at to advance to it. */
export interface LoggedUpdate {
  id: number
  previous: number
}

async function drainAppends(noteId: string, queue: AppendQueue): Promise<void> {
  queue.running = true
  try {
    while (queue.waiting.length > 0) {
      const batch = queue.waiting.splice(0)
      queue.inFlight = batch.length
      try {
        const logged = await commitAppends(noteId, batch)
        batch.forEach((item, i) => item.resolve(logged ? logged[i]! : null))
      } catch (err) {
        for (const item of batch) item.reject(err)
      }
      queue.inFlight = 0
    }
  } finally {
    queue.running = false
    appendQueues.delete(noteId)
  }
}

/**
 * One group commit: the note's rows for `batch`, in order, or null when the
 * note is not live in the batch's vault. A single autocommit statement (one
 * round trip, one WAL flush): the instance check (the shared form of the
 * maintenance lock, as every store transaction takes it), the live check,
 * the id before the batch and the multi-row INSERT. Under the gate no other
 * append of this note is in flight, so the last stored id read here is the
 * one before the batch, and ids are drawn in VALUES order.
 */
async function commitAppends(noteId: string, batch: PendingAppend[]): Promise<LoggedUpdate[] | null> {
  // As every store transaction (storeTransaction): nothing is written while this process has lost its maintenance lock.
  if (writesPaused()) throw new StoreBusyError('maintenance lock connection lost, reconnecting')
  // As lockedNote: a note whose S2b backfill or roll-forward failed at this boot takes nothing until its bin is merged.
  if (!collabNoteMigrated(noteId)) throw new NoteNotMigratedError()
  const vaultId = batch[0]!.vaultId
  const values = sql.join(
    batch.map((item, i) => sql`(${i}::int, ${Buffer.from(item.update)}::bytea, ${item.actor.type}::actor_type, ${item.actor.id ?? null}::uuid)`),
    sql`, `,
  )
  const [result] = (await withKeyLock(appendGate(noteId), () =>
    db.execute(sql`
      WITH inst AS (SELECT pg_try_advisory_xact_lock_shared(${INSTANCE_LOCK_KEY}) AS ok),
      st AS (
        SELECT EXISTS (SELECT 1 FROM notes WHERE id = ${noteId} AND vault_id = ${vaultId} AND deleted_at IS NULL) AS live,
          greatest(
            (SELECT coalesce(max(id), 0) FROM note_updates WHERE note_id = ${noteId} AND rejected_at IS NULL),
            (SELECT coalesce(max(snapshot_through), 0) FROM note_crdt WHERE note_id = ${noteId})) AS previous),
      ins AS (
        INSERT INTO note_updates (note_id, update, actor_type, actor_id, actor_detail)
        SELECT ${noteId}::uuid, v.u, v.t, v.a, ${JSON.stringify({ kind: 'collab' })}::jsonb
        FROM (VALUES ${values}) AS v(i, u, t, a)
        WHERE (SELECT ok FROM inst) AND (SELECT live FROM st)
        ORDER BY v.i
        RETURNING id)
      SELECT (SELECT ok FROM inst) AS ok, (SELECT live FROM st) AS live, (SELECT previous FROM st) AS previous,
        (SELECT coalesce(array_agg(id ORDER BY id), '{}') FROM ins) AS ids`),
  )) as unknown as Array<{ ok: boolean; live: boolean; previous: string | number; ids: Array<string | number> }>
  if (!result?.ok) throw new StoreBusyError('maintenance in progress')
  if (!result.live) return null
  let previous = Number(result.previous)
  return result.ids.map((raw) => {
    const id = Number(raw)
    const logged = { id, previous }
    previous = id
    return logged
  })
}

/**
 * A store of `doc` the relay refused (invalid, over the cap, quarantined):
 * the editors' typing is still appended to the note's CRDT log, and
 * `fold_error` says why the row keeps its last valid version (§5.4 fold
 * step 5). Editors keep their text; the next valid store folds it.
 */
export async function keepRefusedTyping(vaultId: string, noteId: string, doc: Y.Doc, reason: string): Promise<void> {
  const [note] = await db.select({ path: notes.path }).from(notes).where(and(eq(notes.id, noteId), isNull(notes.deletedAt)))
  if (!note) return
  const fold = foldSource(noteId, doc)!
  try {
    await withKeyLock(noteLock(vaultId, note.path), () =>
      storeTransaction([noteId], async (tx) => {
        const locked = await lockedNote(tx, noteId)
        const crdt = locked && !locked.deletedAt ? await readNoteCrdt(tx, noteId) : null
        if (!crdt) return
        await appendUpdate(tx, crdt, Y.encodeStateAsUpdate(fold.base, Y.encodeStateVector(crdt.doc)), SYSTEM_ACTOR, {
          kind: 'typing',
          editors: fold.editors,
          refused: reason,
        })
        await setFoldError(tx, crdt, reason)
      }),
    )
  } finally {
    releaseFold(fold)
  }
}

/**
 * The relay unloaded note `noteId`'s document (§5.4 fold step 6, "on
 * unload"): its tail is folded into the row first, then compacted into the
 * snapshot. Compacting an unfolded tail would delete the rows that tell boot
 * a fold is pending (S3: an acked update whose store never ran).
 */
export async function compactCollabState(vaultId: string, noteId: string): Promise<void> {
  const [note] = await db.select({ path: notes.path }).from(notes).where(eq(notes.id, noteId))
  if (!note) return
  const foldedRow = await withKeyLock(noteLock(vaultId, note.path), () =>
    storeTransaction([noteId], async (tx) => {
      const locked = await lockedNote(tx, noteId)
      const crdt = locked ? await readNoteCrdt(tx, noteId) : null
      if (!locked || !crdt) return false
      const folded = locked.deletedAt ? null : await catchUp(tx, locked, crdt, null, { storeRow: true })
      if (crdt.tailCount > 0) await compactNoteCrdt(tx, crdt)
      return folded !== null && folded.row.seq !== locked.seq
    }),
  )
  if (foldedRow) afterCommit()
}

/**
 * Boot steps 4-5 (§7): every live note whose row moved past its CRDT state
 * is rebased, and every unfolded tail is folded, one transaction per note.
 * A failure is recorded on the note (`fold_error`, a failed `collab-store`
 * job) and counted; boot never stops for one note.
 * `onlyIds` (doctor --repair, #495): only those of these notes that need it.
 * A note whose S2b backfill or roll-forward failed at this boot is left
 * alone (collabNoteMigrated): its bin is merged at the next restart, and a
 * rebase now would add the older release's change a second time then.
 */
export async function foldPendingCollab(onlyIds?: readonly string[]): Promise<{ folded: number; failed: number }> {
  let folded = 0
  let failed = 0
  const needing = (await notesNeedingFold(db)).filter((id) => collabNoteMigrated(id))
  for (const noteId of onlyIds ? needing.filter((id) => onlyIds.includes(id)) : needing) {
    let vaultId: string | null = null
    try {
      const [note] = await db.select({ vaultId: notes.vaultId, path: notes.path }).from(notes).where(and(eq(notes.id, noteId), isNull(notes.deletedAt)))
      if (!note) continue
      vaultId = note.vaultId
      await withKeyLock(noteLock(note.vaultId, note.path), () =>
        storeTransaction([noteId], async (tx) => {
          const locked = await lockedNote(tx, noteId)
          if (!locked || locked.deletedAt) return
          await catchUp(tx, locked, await readNoteCrdt(tx, noteId), null, { storeRow: true })
        }),
      )
      folded++
    } catch (err) {
      failed++
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[collab] boot fold of note ${noteId} failed:`, err)
      recordJob('collab-store', { error: err }, vaultId)
      // §7: a failure sets fold_error (monitoring, the doctor); the next fold clears it.
      await db
        .execute(sql`UPDATE note_crdt SET fold_error = ${`boot fold failed: ${message}`}, updated_at = now() WHERE note_id = ${noteId}`)
        .catch((setErr: unknown) => console.error(`[collab] note ${noteId}: fold_error not recorded:`, setErr))
    }
  }
  // The folds stored rows: wake the projector, so files follow at once, not at its next poll.
  if (folded > 0) afterCommit()
  return { folded, failed }
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
