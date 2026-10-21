/**
 * The transactional store (ADR-003 §5): every server write to a note is one
 * Postgres transaction holding the row, its revision (at the row's new
 * `seq`), its links, its projection targets and its embedding job. Files,
 * directory `index.md` files and embeddings are projections written after
 * commit (notes/projector.ts, search/embedding-queue.ts) and never read back.
 *
 * Locks (§5.1), in this order, as the first statements of the transaction:
 * `SET LOCAL lock_timeout`, the shared form of the instance maintenance lock
 * (`pg_try_advisory_xact_lock_shared`: false while `store-export-legacy`
 * holds the exclusive form, and the write answers "retry"), then the note's
 * own advisory lock keyed by its id. Per-note locks are always
 * transaction-scoped. Table order: notes → note_projections → projected_files.
 */
import { getTableColumns, sql, eq, and, desc, notInArray } from 'drizzle-orm'
import { isDeepStrictEqual } from 'node:util'
import { db } from '../db/client.js'
import { noteLinks, noteRevisions, notes } from '../db/schema.js'
import { extractWikilinks, type Frontmatter } from './okf.js'
import { orderKeys, sameContent } from './frontmatter-order.js'
import type { Actor, NoteRow } from './store.js'

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * The advisory lock key of the instance maintenance lock (§5.1, §9). Every
 * store transaction takes its shared form; `store-export-legacy` takes the
 * exclusive form on a reserved connection, so no write lands while it runs.
 */
export const INSTANCE_LOCK_KEY = 0x454c_4152_4100n

/** How long a store transaction waits for a row or advisory lock before it answers "retry" (§5.1). */
const LOCK_TIMEOUT = '5s'

/** A write refused because the store is busy (lock timeout, maintenance): nothing was committed; retry later. HTTP 503. */
export class StoreBusyError extends Error {
  readonly statusCode = 503
  readonly status = 'retry'
  constructor(reason: string) {
    super(`the note store is busy (${reason}); nothing was written, retry the write`)
  }
}

/** Drizzle wraps driver errors; the Postgres code may sit on `cause`. */
export function pgErrorCode(err: unknown): string | undefined {
  let current: unknown = err
  while (current instanceof Error) {
    const code = 'code' in current ? current.code : undefined
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code
    current = current.cause
  }
  return undefined
}

/** Takes the transaction-scoped advisory lock of one note (by id, §5.1). */
export async function lockNote(tx: Tx, noteId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${noteId}::text, 0))`)
}

/**
 * Runs `fn` in one store transaction: lock timeout, the instance check and,
 * for each id in `noteIds`, the note's advisory lock (sorted, so two
 * transactions over the same notes never wait on each other in a cycle).
 * A lock timeout or a held maintenance lock becomes StoreBusyError.
 */
export async function storeTransaction<T>(noteIds: readonly string[], fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`))
      const [instance] = (await tx.execute(
        sql`SELECT pg_try_advisory_xact_lock_shared(${INSTANCE_LOCK_KEY}) AS ok`,
      )) as unknown as Array<{ ok: boolean }>
      if (!instance?.ok) throw new StoreBusyError('maintenance in progress')
      for (const id of [...new Set(noteIds)].sort()) await lockNote(tx, id)
      return fn(tx)
    })
  } catch (err) {
    if (pgErrorCode(err) === '55P03') throw new StoreBusyError('lock timeout')
    throw err
  }
}

/** A note row as the store reads it under its locks: the model's columns plus `seq` and `frontmatter_src`. */
export type StoredNote = NoteRow & { seq: number; frontmatterSrc: Record<string, unknown> | null }

export const storedColumns = {
  ...getTableColumns(notes),
  seq: sql<string>`${notes}.seq`.as('seq'),
  frontmatterSrc: sql<Record<string, unknown> | null>`${notes}.frontmatter_src`.as('frontmatter_src'),
}

export function toStored(row: NoteRow & { seq: string | number; frontmatterSrc: Record<string, unknown> | null }): StoredNote {
  return { ...row, seq: Number(row.seq) }
}

/**
 * Set by boot (store-reconcile.ts bootStore) while the S2a backfill has not
 * finished: a note the backfill could not process yet is refused for writes
 * (StoreBusyError, "retry"), so its file is never overwritten before the
 * backfill lets it win (Q5).
 */
let migrationPending = false

export function setStoreMigrationPending(pending: boolean): void {
  migrationPending = pending
}

/** `note_projections.projection` of the per-note backfill marker: the backfill processed this note (or it needed none). */
export const BACKFILL_MARKER = 'backfill'

/** The note row `id`, locked FOR UPDATE; null when it does not exist. */
export async function lockedNote(tx: Tx, id: string): Promise<StoredNote | null> {
  const [row] = await tx.select(storedColumns).from(notes).where(eq(notes.id, id)).for('update')
  if (row && migrationPending) {
    const done = await tx.execute(sql`SELECT 1 FROM note_projections WHERE note_id = ${id} AND projection = ${BACKFILL_MARKER}`)
    if ((done as unknown as unknown[]).length === 0) throw new StoreBusyError('this note is not migrated to the store yet')
  }
  return row ? toStored(row) : null
}

/** What a write changes on the row; a field left out keeps its value. */
export interface RowChange {
  frontmatter?: Frontmatter
  body?: string
  path?: string
  type?: string
  name?: string
  deletedAt?: Date | null
}

/** The revision a write records: a content write (`create`/`update`, deduped) or an event (#479). */
export interface RevisionSpec {
  action: string
  actor: Actor
  sourceRevisionId?: string
  fromPath?: string
  toPath?: string
  /** Who and how (#403): the MCP tool, the editors whose typing a fold stored. */
  actorDetail?: Record<string, unknown>
}

/** The revision actions deduped against the latest content revision (#480). */
const DEDUPED_ACTIONS: Record<string, true> = { create: true, update: true }

/** Revisions that never held the note's content, or are not a write's state: never a dedupe baseline. */
const NOT_A_DEDUPE_BASELINE = ['quarantine', 'proposal', 'restore_point', 'delete', 'restore', 'rename', 'revert']

/**
 * Inserts a revision. A write that moved the note to a new `seq` records its
 * revision at that `seq` (ADR-003 I2: the revision at `notes.seq` exists and
 * equals the row). A content write that left `seq` unchanged repeats a stored
 * state: it is recorded (with no `seq`) only as an attributed write of a state
 * someone else stored (#403, see recordRevision in store.ts), never twice for
 * the same actor or for the relay.
 */
export async function insertRevision(
  tx: Tx,
  noteId: string,
  seq: number | null,
  spec: RevisionSpec,
  state: { frontmatter: unknown; body: string },
): Promise<void> {
  if (seq === null && DEDUPED_ACTIONS[spec.action]) {
    const [last] = await tx
      .select({
        frontmatter: noteRevisions.frontmatter,
        body: noteRevisions.body,
        actorType: noteRevisions.actorType,
        actorId: noteRevisions.actorId,
      })
      .from(noteRevisions)
      .where(and(eq(noteRevisions.noteId, noteId), notInArray(noteRevisions.action, NOT_A_DEDUPE_BASELINE)))
      .orderBy(desc(noteRevisions.ord))
      .limit(1)
    const repeatsAuthor =
      spec.actor.type === 'collab' || (last?.actorType === spec.actor.type && last.actorId === (spec.actor.id ?? null))
    if (
      last &&
      repeatsAuthor &&
      last.body === state.body &&
      isDeepStrictEqual(last.frontmatter, JSON.parse(JSON.stringify(state.frontmatter ?? null)))
    ) {
      return
    }
  }
  // `ord` (#825) takes its sequence value here, inside the transaction after
  // the note's locks: writes to one note are serialised by those locks, so its
  // revisions are numbered in commit order.
  await tx.execute(sql`
    INSERT INTO note_revisions
      (note_id, actor_type, actor_id, action, frontmatter, body, seq, actor_detail, source_revision_id, from_path, to_path)
    VALUES (${noteId}, ${spec.actor.type}, ${spec.actor.id ?? null}, ${spec.action},
      ${JSON.stringify(state.frontmatter ?? {})}::jsonb, ${state.body}, ${seq},
      ${spec.actorDetail ? JSON.stringify(spec.actorDetail) : null}::jsonb,
      ${spec.sourceRevisionId ?? null}, ${spec.fromPath ?? null}, ${spec.toPath ?? null})`)
}

/** Replaces the note's EXTRACTED link rows from `body`, inside `tx`. */
export async function replaceLinks(tx: Tx, noteId: string, body: string): Promise<void> {
  const targets = extractWikilinks(body)
  await tx.delete(noteLinks).where(eq(noteLinks.sourceNoteId, noteId))
  if (targets.length > 0) {
    await tx
      .insert(noteLinks)
      .values(targets.map((targetPath) => ({ sourceNoteId: noteId, targetPath })))
      .onConflictDoNothing()
  }
}

/** The projections the projector (notes/projector.ts) keeps per note. */
export type ProjectionKind = 'file' | 'dir_index'

/** Raises the projection targets of a note to `seq` (rows are created when missing). */
export async function raiseProjections(tx: Tx, noteId: string, seq: number, kinds: readonly ProjectionKind[]): Promise<void> {
  for (const kind of kinds) {
    await tx.execute(sql`
      INSERT INTO note_projections (note_id, projection, target_seq) VALUES (${noteId}, ${kind}, ${seq})
      ON CONFLICT (note_id, projection) DO UPDATE
        SET target_seq = GREATEST(note_projections.target_seq, EXCLUDED.target_seq), updated_at = now(), attempts = 0
        WHERE note_projections.target_seq < EXCLUDED.target_seq`)
  }
}

/** The embedding job of the note at `seq` (S5's `embed_note` job, #494), inserted with the write (outbox). */
export async function enqueueEmbeddingTx(tx: Tx, noteId: string, seq: number): Promise<void> {
  await tx.execute(sql`
    INSERT INTO jobs (kind, payload, idempotency_key)
    VALUES ('embed_note', jsonb_build_object('noteId', ${noteId}::text, 'seq', ${seq}::bigint), ${`embed_note:${noteId}:${seq}`})
    ON CONFLICT (idempotency_key) DO NOTHING`)
}

/** Inserts a `jobs` row for work that outlives the note row or spans notes (§5.5); returns its id. */
export async function insertStoreJob(
  tx: Tx,
  kind: string,
  payload: Record<string, unknown>,
  options: { leaseMs?: number } = {},
): Promise<number> {
  const [row] = (await tx.execute(sql`
    INSERT INTO jobs (kind, payload, lease_until, attempts)
    VALUES (${kind}, ${JSON.stringify(payload)}::jsonb,
      ${options.leaseMs ? sql`now() + ${options.leaseMs} * interval '1 millisecond'` : sql`NULL`},
      ${options.leaseMs ? 1 : 0})
    RETURNING id`)) as unknown as Array<{ id: string | number }>
  return Number(row!.id)
}

/** The result of applying a RowChange: the new row and whether `seq` moved. */
export interface Applied {
  row: StoredNote
  changed: boolean
}

/**
 * Applies `change` to the locked row `current` (Invariant W, §5.2 step 6):
 * the row (the trigger bumps `seq` when body, frontmatter, path or
 * `deleted_at` changed) and `frontmatter_src` (orderKeys), the revision,
 * links, projection targets and the embedding job, all in `tx`. A change
 * that changes nothing leaves the row (and `seq`) alone; its revision is
 * then recorded only as insertRevision's dedupe rule allows.
 */
export async function applyRowChange(
  tx: Tx,
  current: StoredNote,
  change: RowChange,
  revision: RevisionSpec,
  options: { frontmatterOrder?: Record<string, unknown> } = {},
): Promise<Applied> {
  const frontmatter = change.frontmatter ?? (current.frontmatter as Frontmatter)
  const body = change.body ?? current.body
  const path = change.path ?? current.path
  const type = change.type ?? current.type
  const name = change.name ?? current.name
  const deletedAt = change.deletedAt === undefined ? current.deletedAt : change.deletedAt
  const frontmatterChanged = !sameContent(frontmatter, current.frontmatter as Record<string, unknown>)
  const listed = path !== current.path || (deletedAt === null) !== (current.deletedAt === null) || frontmatterChanged
  if (!listed && body === current.body && type === current.type && name === current.name) {
    await insertRevision(tx, current.id, null, revision, { frontmatter, body })
    return { row: current, changed: false }
  }
  const frontmatterSrc = orderKeys(options.frontmatterOrder ?? current.frontmatterSrc, frontmatter)
  const [updated] = await tx
    .update(notes)
    .set({ frontmatter, body, path, type, name, deletedAt, updatedAt: new Date() })
    .where(eq(notes.id, current.id))
    .returning(storedColumns)
  await tx.execute(sql`UPDATE notes SET frontmatter_src = ${JSON.stringify(frontmatterSrc)}::json WHERE id = ${current.id}`)
  const row = { ...toStored(updated!), frontmatterSrc }
  const changed = row.seq !== current.seq
  await insertRevision(tx, row.id, changed ? row.seq : null, revision, { frontmatter, body })
  if (!changed) return { row, changed }
  if (body !== current.body) await replaceLinks(tx, row.id, body)
  await raiseProjections(tx, row.id, row.seq, listed ? ['file', 'dir_index'] : ['file'])
  if (deletedAt === null) await enqueueEmbeddingTx(tx, row.id, row.seq)
  return { row, changed }
}
