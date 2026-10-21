/**
 * Revision compaction (#501): a note's long history is stored as deltas
 * instead of one full copy of the note per revision. Lossless: every revision
 * keeps its id, order, metadata and exact body (`revisionBody` in
 * store-tx.ts rebuilds it in SQL), so `get_revision`, `note_history`,
 * revert, `base_rev` merges, restore points, vault export/import and
 * instance backups read what they read before. Nothing is deleted.
 *
 * A compacted revision keeps `body = ''`, its UTF-8 size in `body_bytes`, and
 * in `body_delta` the pieces that rebuild its body from its base
 * `delta_base_id`: the nearest older revision of the same note that is stored
 * whole. A base is never compacted itself (one level: a read costs one more
 * row and one patch), and a revision is encoded only when its delta is under
 * half its size and the deltas against that base stay under the base's own
 * size; otherwise it stays whole and becomes the base of the revisions after
 * it. A history of small edits therefore costs about two full copies per
 * segment of revisions, not one per revision.
 *
 * Always stored whole (retention): the newest KEEP_RECENT_REVISIONS revisions
 * of the note, the revision at the note's `seq` (the note as it is), the
 * rebase base (`note_crdt.folded_seq`, ADR-003 §5.4), restore points
 * (#482), quarantined writes and proposals (#492, #475; a continued
 * quarantine is rewritten in place, so neither is ever a base either), every
 * revision a proposal names as its base (`source_revision_id`), and every
 * revision that is another one's base.
 *
 * It runs as the durable job `compact_revisions` (jobs/durable.ts), queued
 * in the write transaction whenever a note's `seq` reaches a multiple of
 * COMPACT_EVERY_SEQ, and at boot for notes with a long history stored whole.
 * Each batch is one store transaction under the note's lock (at most
 * BATCH_ROWS revisions or BATCH_MS), and each revision is one UPDATE that
 * checks in SQL that the delta rebuilds the body exactly and that the base is
 * still whole. A crash loses at most the batch in flight, which a rerun
 * redoes: a rerun only finds the revisions still whole, so the job is
 * idempotent.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { failpoint } from '../failpoints.js'
import { MAX_JOB_ATTEMPTS, claimJob, completeJob, failCrashedJobs, failJob, jobDrainer, onJobConflict } from '../jobs/durable.js'
import { recordJob } from '../monitoring/metrics.js'
import { diffLines } from '../sync/text-diff.js'
import { COMPACT_EVERY_SEQ, COMPACT_REVISIONS_JOB, storeTransaction, type Tx } from './store-tx.js'

/** The newest revisions of every note that are always stored whole. */
export const KEEP_RECENT_REVISIONS = 20

/** At most this many revisions per transaction, which holds the note's lock for at most about BATCH_MS. */
const BATCH_ROWS = 20
const BATCH_MS = 250

/**
 * The pieces that rebuild a body from its base, concatenated in order: a
 * string is literal text, `[from, count]` copies `count` characters of the
 * base starting at `from` (1-based, counted as Postgres `substr` counts them:
 * code points, not UTF-16 units).
 */
export type RevisionDelta = Array<string | [number, number]>

/** Characters of `text` as Postgres counts them: a surrogate pair is one. */
function codePoints(text: string): number {
  let n = text.length
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    if (unit >= 0xd800 && unit <= 0xdbff) n -= 1
  }
  return n
}

/** The delta from `base` to `body`, per whole line (sync/text-diff.ts `diffLines`). */
export function encodeDelta(base: string, body: string): RevisionDelta {
  const { lines, hunks } = diffLines(base, body)
  const delta: RevisionDelta = []
  let line = 0
  let from = 1
  const copyTo = (end: number) => {
    let count = 0
    for (; line < end; line++) count += codePoints(lines[line]!)
    if (count > 0) delta.push([from, count])
    from += count
  }
  for (const hunk of hunks) {
    copyTo(hunk.start)
    for (; line < hunk.end; line++) from += codePoints(lines[line]!)
    if (hunk.lines.length > 0) delta.push(hunk.lines.join(''))
  }
  copyTo(lines.length)
  return delta
}

/** Revisions never compacted: a restore point (#482), and writes kept out of the note (#492, #475). */
const KEPT_WHOLE = sql`('restore_point', 'quarantine', 'proposal')`
/** Revisions never a base: a continued quarantine is rewritten in place, and neither is the note's content. */
const NOT_A_BASE = sql`('quarantine', 'proposal')`

/** The note's revisions after `after` (its `ord`) that the retention allows to compact, oldest first. */
async function candidates(tx: Tx, noteId: string, after: number): Promise<Array<{ id: string; ord: number }>> {
  const rows = (await tx.execute(sql`
    SELECT r.id, r.ord FROM note_revisions r JOIN notes n ON n.id = r.note_id
    WHERE r.note_id = ${noteId} AND r.ord > ${after} AND r.body_delta IS NULL AND r.action NOT IN ${KEPT_WHOLE}
      AND r.ord < (SELECT k.ord FROM note_revisions k WHERE k.note_id = ${noteId} ORDER BY k.ord DESC OFFSET ${KEEP_RECENT_REVISIONS - 1} LIMIT 1)
      AND r.seq IS DISTINCT FROM n.seq
      AND NOT EXISTS (SELECT 1 FROM note_crdt c WHERE c.note_id = r.note_id AND c.folded_seq = r.seq)
      AND NOT EXISTS (SELECT 1 FROM note_revisions p WHERE p.note_id = r.note_id AND p.action = 'proposal' AND p.source_revision_id = r.id)
      AND NOT EXISTS (SELECT 1 FROM note_revisions d WHERE d.delta_base_id = r.id)
    ORDER BY r.ord LIMIT ${BATCH_ROWS}`)) as unknown as Array<{ id: string; ord: string | number }>
  return rows.map((r) => ({ id: r.id, ord: Number(r.ord) }))
}

/** Stores revision `id` as a delta from the nearest older whole revision when the retention rules above allow it. */
async function compactRevision(tx: Tx, noteId: string, id: string, ord: number): Promise<boolean> {
  const [base] = (await tx.execute(sql`
    SELECT b.id, b.body, octet_length(b.body) AS bytes,
      (SELECT coalesce(sum(octet_length(d.body_delta::text)), 0) FROM note_revisions d WHERE d.delta_base_id = b.id)::bigint AS used
    FROM note_revisions b
    WHERE b.note_id = ${noteId} AND b.ord < ${ord} AND b.body_delta IS NULL AND b.action NOT IN ${NOT_A_BASE}
    ORDER BY b.ord DESC LIMIT 1`)) as unknown as Array<{ id: string; body: string; bytes: number; used: string | number }>
  if (!base) return false
  const [revision] = (await tx.execute(sql`SELECT body FROM note_revisions WHERE id = ${id}`)) as unknown as Array<{ body: string }>
  if (!revision) return false
  const delta = JSON.stringify(encodeDelta(base.body, revision.body))
  const bytes = Buffer.byteLength(delta)
  if (bytes * 2 > Buffer.byteLength(revision.body) || Number(base.used) + bytes > base.bytes) return false
  // SET reads the row as it was: `body_bytes` is the size of the body it replaces.
  const updated = (await tx.execute(sql`
    UPDATE note_revisions r SET body = '', body_delta = ${delta}::jsonb, delta_base_id = b.id, body_bytes = octet_length(r.body)
    FROM note_revisions b
    WHERE r.id = ${id} AND r.body_delta IS NULL AND b.id = ${base.id} AND b.body_delta IS NULL
      AND note_revision_patch(b.body, ${delta}::jsonb) = r.body
    RETURNING r.id`)) as unknown as unknown[]
  if (updated.length === 0) console.warn(`[revision-compaction] revision ${id}: its delta does not rebuild its body; kept whole`)
  return updated.length > 0
}

/**
 * Compacts the history of note `noteId` as far as the retention allows.
 * Returns the number of revisions it compacted (0 on a rerun with nothing new).
 */
export async function compactNoteRevisions(noteId: string): Promise<number> {
  let after = 0
  let total = 0
  for (;;) {
    const batch = await storeTransaction([noteId], async (tx) => {
      const started = Date.now()
      const found = await candidates(tx, noteId, after)
      let compacted = 0
      let last = after
      for (const { id, ord } of found) {
        if (await compactRevision(tx, noteId, id, ord)) compacted += 1
        last = ord
        if (Date.now() - started > BATCH_MS) break
      }
      failpoint('revisions.compact-before-commit')
      return { compacted, last, more: found.length > 0 && (found.length === BATCH_ROWS || last < found.at(-1)!.ord) }
    })
    failpoint('revisions.compact-after-commit')
    total += batch.compacted
    after = batch.last
    if (!batch.more) return total
  }
}

/**
 * Stores whole again every revision whose base is `revisionId`, inside `tx`
 * (the note's store transaction): before that revision is purged.
 */
export async function expandDependents(tx: Tx, revisionId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE note_revisions SET body = note_revision_body(body, body_delta, delta_base_id), body_delta = NULL, delta_base_id = NULL, body_bytes = NULL
    WHERE delta_base_id = ${revisionId}`)
}

async function drainOnce(): Promise<void> {
  await failCrashedJobs(COMPACT_REVISIONS_JOB, 'compaction', 'noteId')
  for (;;) {
    const job = await claimJob<{ noteId: string }>(COMPACT_REVISIONS_JOB)
    if (!job) return
    const { noteId } = job.payload
    try {
      await compactNoteRevisions(noteId)
      await completeJob(job.id)
      recordJob('compaction', 'ok', noteId)
    } catch (err) {
      const gaveUp = await failJob(job, err, 'compaction', noteId)
      console.warn(
        `[revision-compaction] note ${noteId} (attempt ${job.attempts}/${MAX_JOB_ATTEMPTS}${gaveUp ? ', gave up' : ''}):`,
        err,
      )
    }
  }
}

const compaction = jobDrainer('compaction', drainOnce)

/** Wakes the worker after a write committed a `compact_revisions` job (store-tx.ts `enqueueCompactionTx`). */
export function kickRevisionCompaction(): void {
  compaction.kick()
}

/** Awaits pending enqueues and the drain: tests and batch scripts only. */
export async function flushRevisionCompaction(): Promise<void> {
  await compaction.flush()
}

/**
 * Boot catch-up, not awaited: queues the notes whose history has more
 * revisions stored whole than the retention keeps plus one interval of
 * writes (histories written before #501, or by writes that queued no job),
 * keyed at the note's current `seq`: a note unchanged since its last run is
 * queued again only when that run failed with an error.
 */
export function scheduleRevisionCompaction(): void {
  compaction.track(
    db.execute(sql`
      INSERT INTO jobs (kind, payload, idempotency_key)
      SELECT ${COMPACT_REVISIONS_JOB}, jsonb_build_object('noteId', n.id::text, 'seq', n.seq), ${COMPACT_REVISIONS_JOB} || ':' || n.id || ':' || n.seq
      FROM (SELECT note_id FROM note_revisions WHERE body_delta IS NULL
        GROUP BY note_id HAVING count(*) > ${KEEP_RECENT_REVISIONS + COMPACT_EVERY_SEQ}) w
      JOIN notes n ON n.id = w.note_id
      ${onJobConflict('errored')}`),
  )
}
