import { and, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { notes } from '../db/schema.js'
import { embedder } from './embeddings.js'
import { recomputeSemanticEdges } from './semantic-edges.js'
import { recordJob } from '../monitoring/metrics.js'
import {
  MAX_JOB_ATTEMPTS,
  claimJob,
  completeJob,
  erroredJobExists,
  failCrashedJobs,
  failJob,
  jobDrainer,
  onJobConflict,
  type JobRerun,
} from '../jobs/durable.js'

/**
 * Note embeddings run from durable `jobs` rows (#494; see jobs/durable.ts):
 * kind `embed_note`, payload `{noteId, seq}`, key `embed_note:<noteId>:<seq>`.
 * `seq` is the note's version (ADR-003 §4) and never repeats, so a duplicate
 * enqueue of an unchanged note is a no-op. The job embeds the note as it is
 * when it runs, so a burst of edits costs at most one embedding per pending job.
 */
export const EMBEDDING_JOB = 'embed_note'

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
      ${EMBEDDING_JOB} || ':' || n.id || ':' || n.seq
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
 * Boot catch-up: enqueue live notes without an embedding or whose job for
 * their current `seq` failed with an error, and wake the worker. A job that failed with an error runs again; one whose runs ended
 * with the process (`LeaseExpired`) does not (see scheduleMissingExtractions).
 */
export async function scheduleMissingEmbeddings(limit?: number): Promise<number> {
  const query = db
    .select({ id: notes.id })
    .from(notes)
    .where(
      and(
        isNull(notes.deletedAt),
        // An edited note keeps its previous embedding: a failed job for its current `seq` counts too.
        sql`(${notes.embedding} is null OR ${erroredJobExists(sql`${EMBEDDING_JOB} || ':' || ${notes.id} || ':' || "notes"."seq"`)})`,
      ),
    )
  const missing = limit ? await query.limit(limit) : await query
  await enqueueEmbeddings(
    missing.map((r) => r.id),
    'errored',
  )
  embedding.kick()
  return missing.length
}

/**
 * Embedding state of the live notes of these vaults: `pending`, notes whose
 * embedding for their current `seq` is still to come (a pending job, or no
 * job and no embedding: the boot catch-up adds its job); `failed`, notes
 * whose job for their current `seq` gave up; `notes`, all of them. Search
 * reports it next to its results (#442).
 */
export async function embeddingState(vaultIds: string[]): Promise<{ notes: number; pending: number; failed: number }> {
  if (vaultIds.length === 0) return { notes: 0, pending: 0, failed: 0 }
  const [row] = (await db.execute(sql`
    SELECT count(*)::int AS notes,
      (count(*) FILTER (WHERE j.id IS NOT NULL AND j.done_at IS NULL OR j.id IS NULL AND n.embedding IS NULL))::int AS pending,
      (count(*) FILTER (WHERE j.done_at IS NOT NULL AND j.last_error IS NOT NULL))::int AS failed
    FROM notes n
    LEFT JOIN jobs j ON j.idempotency_key = ${EMBEDDING_JOB} || ':' || n.id || ':' || n.seq
    WHERE n.vault_id = ANY(${`{${vaultIds.join(',')}}`}::uuid[]) AND n.deleted_at IS NULL`)) as unknown as [{ notes: number; pending: number; failed: number }]
  return row ?? { notes: 0, pending: 0, failed: 0 }
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

async function processNote(noteId: string): Promise<void> {
  const row = (await db.select().from(notes).where(eq(notes.id, noteId)))[0]
  if (!row || row.deletedAt) return
  const text = `${row.path}\n${JSON.stringify(row.frontmatter)}\n${row.body}`
  const [embedding] = await embedder.embed([text])
  await db.update(notes).set({ embedding }).where(eq(notes.id, noteId))
  await recomputeSemanticEdges('note', noteId, embedding!)
}
