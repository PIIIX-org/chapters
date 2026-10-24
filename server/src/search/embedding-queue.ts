import { sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { EMBEDDER_ID, embedder } from './embeddings.js'
import { recomputeSemanticEdges } from './semantic-edges.js'
import { recordJob } from '../monitoring/metrics.js'
import {
  MAX_JOB_ATTEMPTS,
  catchUpLimits,
  claimJob,
  completeJob,
  erroredJobExists,
  failCrashedJobs,
  failJob,
  jobDrainer,
  jobExists,
  onJobConflict,
  type JobRerun,
} from '../jobs/durable.js'

/**
 * Note embeddings run from durable `jobs` rows (#494; see jobs/durable.ts):
 * kind `embed_note`, payload `{noteId, seq}`, key
 * `embed_note:<noteId>:<seq>:<EMBEDDER_ID>` (#453). `seq` is the note's
 * version (ADR-003 §4) and never repeats, so a duplicate enqueue of an
 * unchanged note is a no-op. The job embeds the note as it is when it runs,
 * so a burst of edits costs at most one embedding per pending job.
 */
export const EMBEDDING_JOB = 'embed_note'

/** The key of the job that embeds note `noteId` at `seq` with the running embedder (#453). */
export function embeddingJobKey(noteId: string, seq: number | string): string {
  return `${EMBEDDING_JOB}:${noteId}:${seq}:${EMBEDDER_ID}`
}

/** `embeddingJobKey` in SQL, from a note row's `id` and `seq`. */
export function embeddingJobKeySql(id: SQL, seq: SQL): SQL {
  return sql`${EMBEDDING_JOB} || ':' || ${id} || ':' || ${seq} || ':' || ${EMBEDDER_ID}`
}

/**
 * Inserts embedding jobs for these live notes at their current `seq` (a
 * repeated id counts once). `rerun: 'finished'` re-embeds (`pnpm reindex`).
 */
export async function enqueueEmbeddings(noteIds: string[], rerun: JobRerun = 'never'): Promise<void> {
  if (noteIds.length === 0) return
  const ids = [...new Set(noteIds)]
  await db.execute(sql`
    INSERT INTO jobs (kind, payload, idempotency_key)
    SELECT ${EMBEDDING_JOB}, jsonb_build_object('noteId', n.id::text, 'seq', n.seq),
      ${embeddingJobKeySql(sql`n.id`, sql`n.seq`)}
    FROM unnest(${`{${ids.join(',')}}`}::uuid[]) WITH ORDINALITY AS u(id, ord)
    JOIN notes n ON n.id = u.id
    WHERE n.deleted_at IS NULL
    ORDER BY u.ord
    ${onJobConflict(rerun)}`)
  embedding.kick()
}

/** Enqueue a note for (re-)embedding. Never blocks the caller (perf rule 2). */
export function scheduleEmbedding(noteId: string): void {
  embedding.track(enqueueEmbeddings([noteId]))
}

/**
 * Wakes the worker after a store write committed its `embed_note` job in the
 * same transaction (ADR-003 §5.2, notes/store-tx.ts). Never blocks the caller.
 */
export function kickEmbeddings(): void {
  embedding.kick()
}

/** Awaits until pending enqueues and the drain are finished — tests and batch jobs only. */
export async function flushEmbeddings(): Promise<void> {
  await embedding.flush()
}

/**
 * Boot catch-up: enqueue live notes without an embedding or with one another
 * `EMBEDDER_ID` produced (#453; null: before #453), unless a job for their
 * current key exists, and notes whose job for their current key failed with
 * an error; then wake the worker. A job that failed with an error runs again;
 * one whose runs ended with the process (`LeaseExpired`) does not (see
 * scheduleMissingExtractions). Keyset pages of `catchUpLimits.batchSize`
 * notes by id, one SELECT and one INSERT each; at most `limit` notes.
 */
export async function scheduleMissingEmbeddings(limit?: number): Promise<number> {
  const key = embeddingJobKeySql(sql`n.id`, sql`n.seq`)
  let after: string | null = null
  let found = 0
  for (;;) {
    const batchSize = Math.min(catchUpLimits.batchSize, limit === undefined ? Infinity : limit - found)
    if (batchSize <= 0) break
    // An edited note keeps its previous embedding: a failed job for its current key counts too.
    const page = (await db.execute(sql`
      SELECT n.id FROM notes n
      WHERE n.deleted_at IS NULL ${after ? sql`AND n.id > ${after}::uuid` : sql``}
        AND (
          ((n.embedding IS NULL OR n.embedder_id IS DISTINCT FROM ${EMBEDDER_ID}) AND NOT ${jobExists(key)})
          OR ${erroredJobExists(key)})
      ORDER BY n.id
      LIMIT ${batchSize}`)) as unknown as Array<{ id: string }>
    await enqueueEmbeddings(
      page.map((r) => r.id),
      'errored',
    )
    found += page.length
    if (page.length < batchSize) break
    after = page.at(-1)!.id
  }
  embedding.kick()
  return found
}

async function drainOnce(): Promise<void> {
  await failCrashedJobs(EMBEDDING_JOB, 'embedding', 'noteId')
  for (;;) {
    const job = await claimJob<{ noteId: string }>(EMBEDDING_JOB)
    if (!job) return
    const { noteId } = job.payload
    try {
      await processNote(noteId)
      await completeJob(job.id)
      recordJob('embedding', 'ok', noteId)
    } catch (err) {
      const gaveUp = await failJob(job, err, 'embedding', noteId)
      if (gaveUp) {
        console.error(
          `[embedding-queue] embedding permanently failed for note ${noteId} after ${MAX_JOB_ATTEMPTS} attempts:`,
          err,
        )
      } else {
        console.warn(
          `[embedding-queue] embedding failed for note ${noteId} (attempt ${job.attempts}/${MAX_JOB_ATTEMPTS}), retrying:`,
          err,
        )
      }
    }
  }
}

const embedding = jobDrainer('embedding', drainOnce)

/**
 * Embeds the note as it is now and writes the vector with its `EMBEDDER_ID`
 * only if the note is still at the `seq` it read (#453): an edit meanwhile
 * moved `seq`, and the write that moved it queued that seq's job, so this
 * result is dropped rather than written over the newer note.
 */
async function processNote(noteId: string): Promise<void> {
  const [row] = (await db.execute(sql`
    SELECT path, frontmatter, body, seq FROM notes WHERE id = ${noteId} AND deleted_at IS NULL`)) as unknown as Array<{
    path: string
    frontmatter: unknown
    body: string
    seq: string
  }>
  if (!row) return
  const embedderId = EMBEDDER_ID
  const [embedding] = await embedder.embed([`${row.path}\n${JSON.stringify(row.frontmatter)}\n${row.body}`])
  const written = (await db.execute(sql`
    UPDATE notes SET embedding = ${JSON.stringify(embedding)}::vector, embedder_id = ${embedderId}
    WHERE id = ${noteId} AND seq = ${row.seq} AND deleted_at IS NULL
    RETURNING id`)) as unknown as unknown[]
  if (written.length > 0) await recomputeSemanticEdges('note', noteId, embedding!)
}
