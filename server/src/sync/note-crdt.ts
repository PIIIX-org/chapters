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
import { noteCrdt, noteUpdates } from '../db/schema.js'
import type { Tx } from '../notes/store-tx.js'
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
  /** The highest non-rejected update id applied to `doc` (the snapshot's own `snapshot_through` when none). */
  lastId: number
  /** Size of the tail and of the snapshot, for the compaction rule. */
  tailCount: number
  tailBytes: number
  snapshotBytes: number
}

function toBytes(value: Uint8Array | Buffer): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

/**
 * Materialises note `noteId`'s CRDT state (FOR UPDATE on its `note_crdt`
 * row), or null when it has none. A stored update that throws when applied
 * is marked `rejected_at` and skipped, and `fold_error` names it (§5.4 fold
 * step 2): one bad update never blocks the note or any other.
 */
export async function readNoteCrdt(tx: Tx, noteId: string): Promise<NoteCrdt | null> {
  const [row] = await tx.select().from(noteCrdt).where(eq(noteCrdt.noteId, noteId)).for('update')
  if (!row) return null
  const doc = new Y.Doc()
  const snapshot = toBytes(row.snapshot)
  Y.applyUpdate(doc, snapshot)
  const tail = await tx
    .select({ id: noteUpdates.id, update: noteUpdates.update })
    .from(noteUpdates)
    .where(and(eq(noteUpdates.noteId, noteId), gt(noteUpdates.id, row.snapshotThrough), isNull(noteUpdates.rejectedAt)))
    .orderBy(asc(noteUpdates.id))
  const crdt: NoteCrdt = {
    noteId,
    doc,
    snapshotThrough: row.snapshotThrough,
    foldedThrough: row.foldedThrough,
    foldedSeq: row.foldedSeq,
    foldError: row.foldError,
    lastId: row.snapshotThrough,
    tailCount: 0,
    tailBytes: 0,
    snapshotBytes: snapshot.byteLength,
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
      crdt.foldError = `update ${id} rejected: ${reason}`
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
    lastId: 0,
    tailCount: 0,
    tailBytes: 0,
    snapshotBytes: snapshot.byteLength,
  }
}

/** Appends `update` to the note's log and applies it to the materialised document. Returns false for an empty update (nothing stored). */
export async function appendUpdate(
  tx: Tx,
  crdt: NoteCrdt,
  update: Uint8Array,
  actor: UpdateActor,
  detail?: Record<string, unknown>,
): Promise<boolean> {
  if (!updateHasContent(update)) return false
  const [row] = await tx
    .insert(noteUpdates)
    .values({
      noteId: crdt.noteId,
      update: Buffer.from(update),
      actorType: actor.type,
      actorId: actor.id ?? null,
      actorDetail: detail ?? null,
    })
    .returning({ id: noteUpdates.id })
  Y.applyUpdate(crdt.doc, update)
  crdt.lastId = row!.id
  crdt.tailCount++
  crdt.tailBytes += update.byteLength
  return true
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
 * 4): `folded_through` advances to the last update and `fold_error` clears.
 * With `foldError` the state does not agree (the relay would refuse it):
 * `folded_through` stays and the error is kept for monitoring and the
 * doctor. Compacts when the tail has outgrown the snapshot.
 */
export async function markFolded(tx: Tx, crdt: NoteCrdt, seq: number, options: { foldError?: string | null } = {}): Promise<void> {
  const foldError = options.foldError ?? null
  const foldedThrough = foldError === null ? crdt.lastId : crdt.foldedThrough
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
