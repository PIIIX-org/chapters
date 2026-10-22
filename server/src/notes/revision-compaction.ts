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
 * still whole. Compaction runs at low priority: a batch does not start, and
 * ends early, while a note's file is waiting to be written (the projector
 * goes first, #880), and each diff is time-limited (DIFF_MS) so it never
 * holds the event loop for long. `note_revision_compaction.examined_through`
 * records the newest revision a run decided on (compacted or kept whole), in
 * the batch's transaction, so a rerun starts after it: a history whose
 * revisions do not compress (a note rewritten whole each time) is diffed
 * once, not again at every run. A crash loses at most the batch in flight,
 * which a rerun redoes, so the job is idempotent. A revision the retention
 * protected when a run passed it (a proposal's base, the rebase base) stays
 * whole.
 */
import { setImmediate, setTimeout as sleep } from 'node:timers/promises'
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
const BATCH_MS = 50
/**
 * The time limit of one revision's line diff: past it the delta is coarser
 * (larger), never wrong. Splitting and hashing the lines comes on top (about
 * 10 ms for 900 KiB), so one revision holds the event loop for about 15 ms.
 */
const DIFF_MS = 5

/** How long a batch waits for the projector before it runs anyway, and how often it looks. */
const YIELD_MAX_MS = 5_000
const YIELD_POLL_MS = 50

/**
 * The pieces that rebuild a body from its base, concatenated in order: a
 * string is literal text, `[from, count]` copies `count` bytes of the base's
 * UTF-8 encoding starting at byte `from` (1-based). Pieces are whole lines,
 * so a copy never starts or ends inside a character, and SQL
 * `note_revision_patch` copies each with a bytea substring in constant time.
 */
export type RevisionDelta = Array<string | [number, number]>

/** The delta from `base` to `body`, per whole line (sync/text-diff.ts `diffLines`). */
export function encodeDelta(base: string, body: string, timeLimitMs?: number): RevisionDelta {
  const { lines, hunks } = diffLines(base, body, timeLimitMs)
  const delta: RevisionDelta = []
  let line = 0
  let from = 1
  const copyTo = (end: number) => {
    let count = 0
    for (; line < end; line++) count += Buffer.byteLength(lines[line]!)
    if (count > 0) delta.push([from, count])
    from += count
  }
  for (const hunk of hunks) {
    copyTo(hunk.start)
    for (; line < hunk.end; line++) from += Buffer.byteLength(lines[line]!)
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

/** True while a note's file or a folder's index.md is waiting to be written (and not failing): compaction waits for it. */
async function projectionPending(): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT 1 FROM note_projections
    WHERE applied_seq < target_seq AND projection IN ('file', 'dir_index') AND last_error IS NULL LIMIT 1`)) as unknown as unknown[]
  return rows.length > 0
}

/** Waits until no projection is pending, or for at most YIELD_MAX_MS. */
async function yieldToProjector(): Promise<void> {
  const until = Date.now() + YIELD_MAX_MS
  while (Date.now() < until && (await projectionPending())) await sleep(YIELD_POLL_MS)
}

/** The base last read in this run: consecutive revisions usually share it, so its body and lines are read once. */
interface BaseCache {
  id: string | null
  body: string
  lines: Set<string>
}

/**
 * UTF-16 units of the lines of `body` that are no line of the base: text a
 * delta must hold as literal (encodeDelta copies whole base lines only), so a
 * lower bound of its size in UTF-8 bytes. About 5 ms for 900 KiB, where the
 * diff takes 30.
 */
function unsharedUnits(baseLines: Set<string>, body: string): number {
  let units = 0
  for (const line of body.split('\n')) if (!baseLines.has(line)) units += line.length + 1
  return units
}

/**
 * Why a revision a run examined stays whole: no older whole revision to be
 * based on, it grew to more than twice its base, it is mostly new text (a
 * rewrite: no diff), its delta would not pay (over half its size, or past its
 * base's budget), or the delta did not rebuild it in SQL.
 */
export type KeptWhole = 'no-base' | 'grew' | 'rewritten' | 'delta' | 'mismatch'

/**
 * Stores revision `id` as a delta from the nearest older whole revision when
 * the retention rules above allow it. Returns `compacted`, or why it stays whole.
 */
async function compactRevision(tx: Tx, noteId: string, id: string, ord: number, cache: BaseCache): Promise<'compacted' | KeptWhole> {
  const [base] = (await tx.execute(sql`
    SELECT b.id, octet_length(b.body) AS bytes,
      (SELECT coalesce(sum(octet_length(d.body_delta::text)), 0) FROM note_revisions d WHERE d.delta_base_id = b.id)::bigint AS used
    FROM note_revisions b
    WHERE b.note_id = ${noteId} AND b.ord < ${ord} AND b.body_delta IS NULL AND b.action NOT IN ${NOT_A_BASE}
    ORDER BY b.ord DESC LIMIT 1`)) as unknown as Array<{ id: string; bytes: number; used: string | number }>
  if (!base) return 'no-base'
  const [revision] = (await tx.execute(sql`SELECT body, octet_length(body) AS bytes FROM note_revisions WHERE id = ${id}`)) as unknown as Array<{
    body: string
    bytes: number
  }>
  if (!revision) return 'no-base'
  // A body more than twice its base's size needs literal text over half its size: no delta can pay, so no diff.
  if ((revision.bytes - base.bytes) * 2 > revision.bytes) return 'grew'
  if (cache.id !== base.id) {
    const [whole] = (await tx.execute(sql`SELECT body FROM note_revisions WHERE id = ${base.id}`)) as unknown as Array<{ body: string }>
    cache.id = base.id
    cache.body = whole!.body
    cache.lines = new Set(whole!.body.split('\n'))
    await setImmediate()
  }
  // Most of the body is new text (a rewrite): no delta can pay, so no diff.
  if (unsharedUnits(cache.lines, revision.body) * 2 > revision.bytes) return 'rewritten'
  // Each step of a big note takes several milliseconds: let waiting work run between them.
  await setImmediate()
  const delta = JSON.stringify(encodeDelta(cache.body, revision.body, DIFF_MS))
  const bytes = Buffer.byteLength(delta)
  if (bytes * 2 > revision.bytes || Number(base.used) + bytes > base.bytes) return 'delta'
  // SET reads the row as it was: `body_bytes` is the size of the body it replaces.
  const updated = (await tx.execute(sql`
    UPDATE note_revisions r SET body = '', body_delta = ${delta}::jsonb, delta_base_id = b.id, body_bytes = octet_length(r.body)
    FROM note_revisions b
    WHERE r.id = ${id} AND r.body_delta IS NULL AND b.id = ${base.id} AND b.body_delta IS NULL
      AND note_revision_patch(b.body, ${delta}::jsonb) = r.body
    RETURNING r.id`)) as unknown as unknown[]
  if (updated.length > 0) return 'compacted'
  console.warn(`[revision-compaction] revision ${id}: its delta does not rebuild its body; kept whole`)
  return 'mismatch'
}

/** What one run did: revisions it stored as deltas, revisions it decided on, and why the others stay whole. */
export interface CompactionRun {
  compacted: number
  examined: number
  kept: Partial<Record<KeptWhole, number>>
}

/**
 * Compacts the history of note `noteId` as far as the retention allows,
 * starting after the newest revision an earlier run decided on.
 */
export async function compactNoteRevisions(noteId: string): Promise<CompactionRun> {
  const [mark] = (await db.execute(sql`
    SELECT examined_through FROM note_revision_compaction WHERE note_id = ${noteId}`)) as unknown as Array<{ examined_through: string }>
  let after = Number(mark?.examined_through ?? 0)
  const run: CompactionRun = { compacted: 0, examined: 0, kept: {} }
  const cache: BaseCache = { id: null, body: '', lines: new Set() }
  for (;;) {
    await yieldToProjector()
    const batch = await storeTransaction([noteId], async (tx) => {
      const started = Date.now()
      const found = await candidates(tx, noteId, after)
      let compacted = 0
      let examined = 0
      const kept: CompactionRun['kept'] = {}
      let last = after
      for (const { id, ord } of found) {
        const outcome = await compactRevision(tx, noteId, id, ord, cache)
        if (outcome === 'compacted') compacted += 1
        else kept[outcome] = (kept[outcome] ?? 0) + 1
        examined += 1
        last = ord
        if (Date.now() - started > BATCH_MS || (await projectionPending())) break
      }
      if (last > after) {
        await tx.execute(sql`
          INSERT INTO note_revision_compaction (note_id, examined_through) VALUES (${noteId}, ${last})
          ON CONFLICT (note_id) DO UPDATE SET examined_through = GREATEST(note_revision_compaction.examined_through, EXCLUDED.examined_through)`)
      }
      failpoint('revisions.compact-before-commit')
      return { compacted, examined, kept, last, more: found.length > 0 && (found.length === BATCH_ROWS || last < found.at(-1)!.ord) }
    })
    failpoint('revisions.compact-after-commit')
    run.compacted += batch.compacted
    run.examined += batch.examined
    for (const [reason, n] of Object.entries(batch.kept) as Array<[KeptWhole, number]>) run.kept[reason] = (run.kept[reason] ?? 0) + n
    after = batch.last
    if (!batch.more) return run
  }
}

/**
 * Stores whole again every revision whose base is `revisionId`, inside `tx`
 * (the note's store transaction): before that revision is purged. The note's
 * next run examines them again (its `examined_through` moves back before them).
 */
export async function expandDependents(tx: Tx, revisionId: string): Promise<void> {
  await tx.execute(sql`
    WITH expanded AS (
      UPDATE note_revisions SET body = note_revision_body(body, body_delta, delta_base_id), body_delta = NULL, delta_base_id = NULL, body_bytes = NULL
      WHERE delta_base_id = ${revisionId}
      RETURNING note_id, ord)
    UPDATE note_revision_compaction c SET examined_through = LEAST(c.examined_through, e.first - 1)
    FROM (SELECT note_id, min(ord) AS first FROM expanded GROUP BY note_id) e
    WHERE c.note_id = e.note_id`)
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
