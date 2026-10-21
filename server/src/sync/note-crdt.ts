/**
 * A note's Yjs state in Postgres (ADR-003 §4, §5.4, S2b): `note_crdt` holds
 * the snapshot, `note_updates` the tail appended since. The current document
 * is always `snapshot ⊕` the non-rejected updates with `id > snapshot_through`,
 * in id order. Nothing here takes a lock: every caller runs inside a store
 * transaction that holds the note's locks (notes/store-tx.ts), so appends to
 * one note commit in id order.
 *
 * `.crdt/<path>.bin` files are no longer read or written, except by the S2b
 * backfill (collab-backfill.ts), which attaches them here once.
 */
import { createHash } from 'node:crypto'
import { and, asc, eq, gt, isNull, lte, sql } from 'drizzle-orm'
import * as Y from 'yjs'
import type { db } from '../db/client.js'
import { noteCrdt, noteUpdates } from '../db/schema.js'
import type { Tx } from '../notes/store-tx.js'
import { withKeyLock } from '../notes/key-lock.js'
import { recordJob } from '../monitoring/metrics.js'
import { SERVER_CLIENT_ID, type DocState } from './live-docs.js'

/** The seed format version (§5.4 "Seed"): part of the hash, so a changed seed recipe never shares a client id with an old one. */
export const SEED_VERSION = 'elara-seed/1'

/** JSON with every object's keys sorted, recursively: the seed's frontmatter input. */
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJSON(item)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON((value as Record<string, unknown>)[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/**
 * The client id of a note's seed (§5.4): the first 4 bytes of
 * `sha256("elara-seed/1\0" ‖ noteId ‖ "\0" ‖ body ‖ "\0" ‖ canonicalJSON(frontmatter))`.
 * Identical input gives the same id (two seeds merge item for item); any
 * other input gives another id, so the two never "share history".
 */
export function seedClientId(noteId: string, state: DocState): number {
  const hash = createHash('sha256')
    .update(`${SEED_VERSION}\0${noteId}\0${state.body}\0${canonicalJSON(state.frontmatter)}`)
    .digest()
  return hash.readUInt32BE(0)
}

/**
 * The deterministic seed of a note with no CRDT state: the body, then the
 * frontmatter keys in sorted order, under the seed client id; then the
 * document switches to the server's process client id before anything else
 * is authored, so no second lineage ever continues under the seed id.
 */
export function seedDocument(noteId: string, state: DocState): Y.Doc {
  const doc = new Y.Doc()
  doc.clientID = seedClientId(noteId, state)
  doc.transact(() => {
    if (state.body.length > 0) doc.getText('body').insert(0, state.body)
    const map = doc.getMap('frontmatter')
    for (const key of Object.keys(state.frontmatter).sort()) map.set(key, state.frontmatter[key])
  })
  doc.clientID = SERVER_CLIENT_ID
  return doc
}

/** True when a Yjs update carries anything (an insert or a delete); an empty diff is not stored. */
export function updateHasContent(update: Uint8Array): boolean {
  const decoded = Y.decodeUpdate(update)
  return decoded.structs.length > 0 || decoded.ds.clients.size > 0
}

/** Who appended an update (#403). */
export interface UpdateActor {
  type: 'user' | 'mcp' | 'collab'
  id?: string
}

/** A note's CRDT state as one store transaction sees it: the materialised document and the bookkeeping. */
export interface NoteCrdt {
  noteId: string
  /** `snapshot ⊕ tail`: what the editors' document holds once the tail is applied. */
  doc: Y.Doc
  snapshotThrough: number
  foldedThrough: number
  foldedSeq: number
  foldError: string | null
  /**
   * Why a stored update was rejected while this transaction materialised the
   * state (§5.4 fold step 2), or null: a fold in the same transaction keeps it
   * as `fold_error` instead of clearing it.
   */
  rejected: string | null
  /** The highest non-rejected update id applied to `doc` (the snapshot's own `snapshot_through` when none). */
  lastId: number
  /** Size of the tail and of the snapshot, for the compaction rule. */
  tailCount: number
  tailBytes: number
  snapshotBytes: number
  /**
   * The state vector of the stored state when `doc` holds more than that:
   * `doc` is then a clone of the open document (readNoteCrdt with a
   * matching cached state), and the editors' typing is the delta over this
   * vector. Null when `doc` is the stored state itself.
   */
  storedStateVector: Uint8Array | null
}

function toBytes(value: Uint8Array | Buffer): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

/**
 * The in-process key every relay append of note `noteId` holds from its id
 * to its COMMIT (S3), and that a materialisation holds only around its tail
 * read. Appends do not take the note's lock, so a fold never delays an ack;
 * this key is what makes the tail read a clean boundary: no append is in
 * flight while it runs, so every row with a lower id is committed and seen,
 * and every later append gets a higher id. Folding and compaction stop at
 * that boundary (`lastId`), never past an unseen row.
 */
export function appendGate(noteId: string): string {
  return `append:${noteId}`
}

/**
 * What the database holds for an open document's note (ADR-003 §5.4 "Before
 * S3"): the state vector of `note_crdt` ⊕ tail and the last update id it
 * includes. Set at load and after every commit that appended or folded with
 * the document in hand; dropped on `fold_error` and with the document. While
 * it matches the database (same last update id, no `fold_error`, row folded
 * at its `seq`), a write materialises nothing: the open document already
 * holds that state, and its typing is the delta over the cached vector.
 */
export interface StoredState {
  noteId: string
  stateVector: Uint8Array
  lastId: number
}

const storedStates = new WeakMap<Y.Doc, StoredState>()

/** What `crdt` holds as stored once its transaction commits, or null while `fold_error` is set (nothing is cached then). */
export function storedStateOf(crdt: NoteCrdt): StoredState | null {
  return crdt.foldError === null ? { noteId: crdt.noteId, stateVector: Y.encodeStateVector(crdt.doc), lastId: crdt.lastId } : null
}

/** After the commit: `live` (an open document of the note) holds `state`; null forgets what was cached. */
export function rememberStoredState(live: Y.Doc, state: StoredState | null): void {
  if (state) storedStates.set(live, state)
  else storedStates.delete(live)
}

/** Records the stored state an open document was just loaded from (ids up to `lastId`). */
export function rememberLoadedState(live: Y.Doc, noteId: string, lastId: number): void {
  storedStates.set(live, { noteId, stateVector: Y.encodeStateVector(live), lastId })
}

/**
 * S3: the relay logged update `id` (the note's previous update was
 * `previous`) and `live` applied it. If the cached stored state was exactly
 * at `previous`, `live` now holds the stored state through `id`, so the
 * cache advances and the next store need not materialise. Any other order
 * (a concurrent append, a write's own rows) leaves it behind, and the next
 * read finds the last id moved and materialises.
 */
export function advanceStoredState(live: Y.Doc, noteId: string, previous: number, id: number): void {
  const cached = storedStates.get(live)
  if (cached && cached.noteId === noteId && cached.lastId === previous) storedStates.set(live, { noteId, stateVector: Y.encodeStateVector(live), lastId: id })
}

/**
 * An open document a write has in hand: `live` itself, `base` the clone the
 * write is computed from, and the row's `seq` under the lock. readNoteCrdt
 * uses its cached stored state when it still matches.
 */
export interface OpenDocument {
  live: Y.Doc
  base: Y.Doc
  seq: number
}

/**
 * Note `noteId`'s CRDT state (FOR UPDATE on its `note_crdt` row), or null
 * when it has none. With `open`, whose cached stored state matches the
 * database (last update id, no `fold_error`, folded at the row's `seq`), the
 * state is `open.base` and nothing is materialised: only the bookkeeping is
 * read. Otherwise `snapshot ⊕` the tail is materialised; a stored update
 * that throws when applied is marked `rejected_at` and skipped, and
 * `fold_error` names it (§5.4 fold step 2): one bad update never blocks the
 * note or any other.
 */
export async function readNoteCrdt(tx: Tx, noteId: string, open?: OpenDocument): Promise<NoteCrdt | null> {
  const cached = open ? storedStates.get(open.live) : undefined
  if (open && cached && cached.noteId === noteId) {
    // Under the append gate, like the materialised tail read: the last id is a boundary no later append falls under (S3).
    const [row] = (await withKeyLock(appendGate(noteId), () => tx.execute(sql`
      SELECT c.snapshot_through, c.folded_through, c.folded_seq, c.fold_error, octet_length(c.snapshot) AS snapshot_bytes,
        coalesce(t.last_id, c.snapshot_through) AS last_id, coalesce(t.n, 0) AS tail_count, coalesce(t.bytes, 0) AS tail_bytes
      FROM note_crdt c
      LEFT JOIN LATERAL (
        SELECT max(u.id) AS last_id, count(*) AS n, sum(octet_length(u.update)) AS bytes FROM note_updates u
        WHERE u.note_id = c.note_id AND u.id > c.snapshot_through AND u.rejected_at IS NULL
      ) t ON true
      WHERE c.note_id = ${noteId} FOR UPDATE OF c`))) as unknown as Array<Record<string, string | number | null>>
    if (!row) return null
    const lastId = Number(row.last_id)
    if (lastId === cached.lastId && row.fold_error === null && Number(row.folded_seq) === open.seq) {
      materialised.cached++
      return {
        noteId,
        doc: open.base,
        snapshotThrough: Number(row.snapshot_through),
        foldedThrough: Number(row.folded_through),
        foldedSeq: Number(row.folded_seq),
        foldError: null,
        rejected: null,
        lastId,
        tailCount: Number(row.tail_count),
        tailBytes: Number(row.tail_bytes),
        snapshotBytes: Number(row.snapshot_bytes),
        storedStateVector: cached.stateVector,
      }
    }
    storedStates.delete(open.live)
  }
  materialised.full++
  return materialise(tx, noteId)
}

/** How readNoteCrdt served its callers: from an open document's cached state, or materialised (for tests and measurements). */
export const materialised = { cached: 0, full: 0 }

/** `snapshot ⊕` the non-rejected tail, rejecting a stored update that does not apply (see readNoteCrdt). */
async function materialise(tx: Tx, noteId: string): Promise<NoteCrdt | null> {
  const [row] = await tx.select().from(noteCrdt).where(eq(noteCrdt.noteId, noteId)).for('update')
  if (!row) return null
  const doc = new Y.Doc()
  const snapshot = toBytes(row.snapshot)
  Y.applyUpdate(doc, snapshot)
  const tail = await withKeyLock(appendGate(noteId), () =>
    tx
      .select({ id: noteUpdates.id, update: noteUpdates.update })
      .from(noteUpdates)
      .where(and(eq(noteUpdates.noteId, noteId), gt(noteUpdates.id, row.snapshotThrough), isNull(noteUpdates.rejectedAt)))
      .orderBy(asc(noteUpdates.id)),
  )
  const crdt: NoteCrdt = {
    noteId,
    doc,
    snapshotThrough: row.snapshotThrough,
    foldedThrough: row.foldedThrough,
    foldedSeq: row.foldedSeq,
    foldError: row.foldError,
    rejected: null,
    lastId: row.snapshotThrough,
    tailCount: 0,
    tailBytes: 0,
    snapshotBytes: snapshot.byteLength,
    storedStateVector: null,
  }
  for (const { id, update } of tail) {
    try {
      Y.applyUpdate(doc, toBytes(update))
      crdt.lastId = id
      crdt.tailCount++
      crdt.tailBytes += update.byteLength
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      await tx
        .update(noteUpdates)
        .set({ rejectedAt: new Date(), rejectReason: reason })
        .where(eq(noteUpdates.id, id))
      crdt.rejected = `update ${id} rejected: ${reason}`
      await setFoldError(tx, crdt, crdt.rejected)
      recordJob('collab-store', { error: { name: 'UpdateRejected', message: crdt.rejected } }, noteId)
      console.error(`[collab] note ${noteId}: stored update ${id} does not apply and was rejected: ${reason}`)
    }
  }
  return crdt
}

/** Creates the note's CRDT state from `doc` (a seed, or a bin the backfill attached), agreeing with the row at `seq`. */
export async function insertNoteCrdt(tx: Tx, noteId: string, doc: Y.Doc, seq: number): Promise<NoteCrdt> {
  const snapshot = Y.encodeStateAsUpdate(doc)
  await tx.insert(noteCrdt).values({ noteId, snapshot: Buffer.from(snapshot), foldedSeq: seq })
  return {
    noteId,
    doc,
    snapshotThrough: 0,
    foldedThrough: 0,
    foldedSeq: seq,
    foldError: null,
    rejected: null,
    lastId: 0,
    tailCount: 0,
    tailBytes: 0,
    snapshotBytes: snapshot.byteLength,
    storedStateVector: null,
  }
}

/**
 * Appends a server-authored `update` (a write, a rebase, refused typing) to
 * the note's log inside the caller's locked transaction and applies it to
 * the materialised document. `lastId` stays at the tail-read boundary: a
 * relay append committed after that read may have a lower id than this row,
 * so this row is left for the next fold to see again (applying it twice is
 * harmless) rather than marking the unseen one folded. Returns false for an
 * empty update (nothing stored).
 */
export async function appendUpdate(
  tx: Tx,
  crdt: NoteCrdt,
  update: Uint8Array,
  actor: UpdateActor,
  detail?: Record<string, unknown>,
): Promise<boolean> {
  // Nothing the state lacks (S3: typing is already logged by the relay; a full delete set alone is not news): nothing stored.
  if (!updateHasContent(update) || Y.snapshotContainsUpdate(Y.snapshot(crdt.doc), update)) return false
  await tx.insert(noteUpdates).values({
    noteId: crdt.noteId,
    update: Buffer.from(update),
    actorType: actor.type,
    actorId: actor.id ?? null,
    actorDetail: detail ?? null,
  })
  Y.applyUpdate(crdt.doc, update)
  crdt.tailCount++
  crdt.tailBytes += update.byteLength
  return true
}

/** Marks a logged update `rejected_at` (§5.4 Append step 5): the live document did not take it, so no fold applies it. */
export async function rejectUpdate(client: Tx | typeof db, id: number, reason: string): Promise<void> {
  await client.update(noteUpdates).set({ rejectedAt: new Date(), rejectReason: reason }).where(eq(noteUpdates.id, id))
}

/** Tail size past which a fold also compacts (§5.4 fold step 6): scaled to the snapshot, so a big note does not rewrite it every few seconds. */
const COMPACT_UPDATES = 500
const COMPACT_BYTES = 256 * 1024
const COMPACT_SNAPSHOT_SHARE = 0.25

/**
 * Compaction (§5.4 fold step 6): the materialised state becomes the
 * snapshot and the compacted, non-rejected updates are deleted. Only a
 * re-encoded snapshot drops deleted text (gc), so purge_revision always
 * compacts. Materialisation starts from `snapshot_through`, never from
 * `folded_through`, so this is safe while a `fold_error` holds that back.
 */
export async function compactNoteCrdt(tx: Tx, crdt: NoteCrdt): Promise<void> {
  const snapshot = Y.encodeStateAsUpdate(crdt.doc)
  await tx
    .delete(noteUpdates)
    .where(and(eq(noteUpdates.noteId, crdt.noteId), lte(noteUpdates.id, crdt.lastId), isNull(noteUpdates.rejectedAt)))
  await tx
    .update(noteCrdt)
    .set({ snapshot: Buffer.from(snapshot), snapshotThrough: crdt.lastId, updatedAt: new Date() })
    .where(eq(noteCrdt.noteId, crdt.noteId))
  crdt.snapshotThrough = crdt.lastId
  crdt.snapshotBytes = snapshot.byteLength
  crdt.tailCount = 0
  crdt.tailBytes = 0
}

/**
 * Records that the CRDT state agrees with the row at `seq` (§5.4 fold step
 * 4): `folded_through` advances to the last update and `fold_error` clears,
 * unless this transaction rejected a stored update (then it names it).
 * With `foldError` the state does not agree (the relay would refuse it):
 * `folded_through` stays and the error is kept for monitoring and the
 * doctor. Compacts when the tail has outgrown the snapshot.
 */
export async function markFolded(tx: Tx, crdt: NoteCrdt, seq: number, options: { foldError?: string | null } = {}): Promise<void> {
  const refused = options.foldError ?? null
  // A rejected update (readNoteCrdt) does not hold the fold back, but its error stays visible.
  const foldError = refused ?? crdt.rejected
  const foldedThrough = refused === null ? crdt.lastId : crdt.foldedThrough
  await tx
    .update(noteCrdt)
    .set({ foldedThrough, foldedSeq: seq, foldError, updatedAt: new Date() })
    .where(eq(noteCrdt.noteId, crdt.noteId))
  crdt.foldedThrough = foldedThrough
  crdt.foldedSeq = seq
  crdt.foldError = foldError
  // Scaled to the snapshot, so a big note does not rewrite it every few seconds.
  if (
    crdt.tailCount > 0 &&
    (crdt.tailCount > COMPACT_UPDATES || crdt.tailBytes > COMPACT_BYTES || crdt.tailBytes > crdt.snapshotBytes * COMPACT_SNAPSHOT_SHARE)
  ) {
    await compactNoteCrdt(tx, crdt)
  }
}

/** Sets `fold_error` without moving anything else: a store the relay refused (invalid, too large, quarantined). */
export async function setFoldError(tx: Tx, crdt: NoteCrdt, foldError: string): Promise<void> {
  await tx.update(noteCrdt).set({ foldError, updatedAt: new Date() }).where(eq(noteCrdt.noteId, crdt.noteId))
  crdt.foldError = foldError
}

/** Notes whose CRDT state needs boot work (§7 steps 4-5): the row moved past `folded_seq`, or an unfolded, non-rejected tail. */
export async function notesNeedingFold(tx: Tx | Pick<Tx, 'execute'>): Promise<string[]> {
  const rows = (await tx.execute(sql`
    SELECT c.note_id FROM note_crdt c JOIN notes n ON n.id = c.note_id
    WHERE n.seq > c.folded_seq
       OR EXISTS (SELECT 1 FROM note_updates u
                  WHERE u.note_id = c.note_id AND u.id > c.folded_through AND u.rejected_at IS NULL)`)) as unknown as Array<{
    note_id: string
  }>
  return rows.map((r) => r.note_id)
}
