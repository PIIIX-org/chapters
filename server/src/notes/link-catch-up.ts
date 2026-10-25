/**
 * The `note_links` catch-up (#472): link rows a save did not write whole,
 * those without a context (written before migration 0039, or by older code
 * after a rollback) and those without lines too (before 0031, #558), are
 * rewritten from their note's body. `replaceLinks` runs only when a body
 * changes, so nothing else would ever fill them.
 *
 * Durable jobs (`jobs/durable.ts`), kind `note_links`, payload `{noteId}`,
 * key `note_links:<noteId>:<seq>`, queued at boot at `JOB_PRIORITY.catchUp`.
 * Each job rewrites the note's rows under its lock, as the doctor's
 * `links-differ` repair does.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  JOB_PRIORITY,
  MAX_JOB_ATTEMPTS,
  catchUpLimits,
  claimJob,
  completeJob,
  failCrashedJobs,
  failJob,
  jobDrainer,
  onJobConflict,
} from '../jobs/durable.js'
import { recordJob } from '../monitoring/metrics.js'
import { replaceLinks, storeTransaction } from './store-tx.js'

export const LINK_ROWS_JOB = 'note_links'

async function drainOnce(): Promise<void> {
  await failCrashedJobs(LINK_ROWS_JOB, 'links', 'noteId')
  for (;;) {
    const job = await claimJob<{ noteId: string }>(LINK_ROWS_JOB)
    if (!job) return
    const { noteId } = job.payload
    try {
      await storeTransaction([noteId], async (tx) => {
        const [row] = (await tx.execute(sql`SELECT body FROM notes WHERE id = ${noteId}`)) as unknown as Array<{ body: string }>
        if (row) await replaceLinks(tx, noteId, row.body)
      })
      await completeJob(job.id)
      recordJob('links', 'ok', noteId)
    } catch (err) {
      const gaveUp = await failJob(job, err, 'links', noteId)
      console.warn(`[link-catch-up] note ${noteId} (attempt ${job.attempts}/${MAX_JOB_ATTEMPTS}${gaveUp ? ', gave up' : ''}):`, err)
    }
  }
}

const links = jobDrainer('links', drainOnce)

/** Awaits pending enqueues and the drain: tests and batch scripts only. */
export async function flushLinkCatchUp(): Promise<void> {
  await links.flush()
}

/**
 * Boot catch-up: queues a job for every note with a row whose context is
 * null (the partial index `note_links_unfilled_idx`), at its current `seq`;
 * a job for that key that failed with an error runs again. Keyset pages of
 * `catchUpLimits.batchSize` notes by id, one statement each; then wakes the
 * worker. Returns the notes found.
 */
export async function scheduleLinkCatchUp(): Promise<number> {
  let after: string | null = null
  let found = 0
  for (;;) {
    const page = (await db.execute(sql`
      WITH page AS (
        SELECT DISTINCT source_note_id AS id FROM note_links
        WHERE context IS NULL ${after ? sql`AND source_note_id > ${after}::uuid` : sql``}
        ORDER BY 1 LIMIT ${catchUpLimits.batchSize}),
      queued AS (
        INSERT INTO jobs (kind, payload, idempotency_key, priority)
        SELECT ${LINK_ROWS_JOB}, jsonb_build_object('noteId', n.id::text), ${LINK_ROWS_JOB} || ':' || n.id || ':' || n.seq, ${JOB_PRIORITY.catchUp}::smallint
        FROM page JOIN notes n ON n.id = page.id
        ORDER BY n.id
        ${onJobConflict('errored')})
      SELECT id FROM page ORDER BY id`)) as unknown as Array<{ id: string }>
    found += page.length
    if (page.length < catchUpLimits.batchSize) break
    after = page.at(-1)!.id
  }
  links.kick()
  return found
}
