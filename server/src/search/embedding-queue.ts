import { sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { noteBlocks } from '../notes/note-blocks.js'
import { replaceBlockSet, vectorsByEmbedKey } from './block-rows.js'
import { CHUNK_VERSION, embedKey } from './embed-key.js'
import { EMBEDDER_ID, embedder } from './embeddings.js'
import { refreshSemanticEdges } from './semantic-edges.js'
import { recordJob } from '../monitoring/metrics.js'
import {
  JOB_PRIORITY,
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
  type JobPriority,
  type JobRerun,
} from '../jobs/durable.js'

/**
 * Note embeddings run from durable `jobs` rows (#494; see jobs/durable.ts):
 * kind `embed_note`, payload `{noteId, seq}`, key
 * `embed_note:<noteId>:<seq>:<EMBEDDER_ID>+chunk<CHUNK_VERSION>` (#453,
 * #452). `seq` is the note's version (ADR-003 §4) and never repeats, so a
 * duplicate enqueue of an unchanged note is a no-op. The job writes the
 * note's block set (notes/note-blocks.ts) for its `seq`; every write that
 * moves `seq` queues that seq's job (notes/store-tx.ts), so a job for a seq
 * the note has moved past is skipped and a burst of edits costs at most one
 * embedding of each changed block per pending job.
 */
export const EMBEDDING_JOB = 'embed_note'

/** The key of the job that embeds note `noteId` at `seq` with the running embedder and chunker (#453, #452). */
export function embeddingJobKey(noteId: string, seq: number | string): string {
  return `${EMBEDDING_JOB}:${noteId}:${seq}:${EMBEDDER_ID}+chunk${CHUNK_VERSION}`
}

/** `embeddingJobKey` in SQL, from a note row's `id` and `seq`. */
export function embeddingJobKeySql(id: SQL, seq: SQL): SQL {
  return sql`${EMBEDDING_JOB} || ':' || ${id} || ':' || ${seq} || ':' || ${`${EMBEDDER_ID}+chunk${CHUNK_VERSION}`}`
}

/**
 * True when the note row `n` has the blocks of its current `seq`, made by the
 * running embedder and chunker (`owner_version` = its seq; the legacy block
 * migration 0036 carried over has none). Every embed writes at least one
 * block.
 */
export function noteBlocksCurrentSql(): SQL {
  return sql`(EXISTS (SELECT 1 FROM blocks b WHERE b.owner_type = 'note' AND b.owner_id = n.id AND b.owner_version = n.seq::text)
    AND n.embedder_id IS NOT DISTINCT FROM ${EMBEDDER_ID} AND n.chunk_version = ${CHUNK_VERSION})`
}

/**
 * Inserts embedding jobs for these live notes at their current `seq` (a
 * repeated id counts once), at `priority`. `rerun: 'finished'` re-embeds
 * (`pnpm reindex`, at catch-up priority).
 */
export async function enqueueEmbeddings(
  noteIds: string[],
  rerun: JobRerun = 'never',
  priority: JobPriority = JOB_PRIORITY.write,
): Promise<void> {
  if (noteIds.length === 0) return
  const ids = [...new Set(noteIds)]
  await db.execute(sql`
    INSERT INTO jobs (kind, payload, idempotency_key, priority)
    SELECT ${EMBEDDING_JOB}, jsonb_build_object('noteId', n.id::text, 'seq', n.seq),
      ${embeddingJobKeySql(sql`n.id`, sql`n.seq`)}, ${priority}::smallint
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
 * Boot catch-up: enqueue live notes without the blocks of their current seq,
 * embedder and chunker (`noteBlocksCurrentSql`; e.g. only the legacy block
 * migration 0036 carried over, or another `EMBEDDER_ID` or `CHUNK_VERSION`
 * made them), unless a job for their current key exists, and notes whose
 * job for their current key failed with an error; then wake the worker. A
 * job that failed with an error runs again; one whose runs ended with the
 * process (`LeaseExpired`) does not (see scheduleMissingExtractions). Keyset
 * pages of `catchUpLimits.batchSize` notes by id, one SELECT and one INSERT
 * each; at most `limit` notes.
 */
export async function scheduleMissingEmbeddings(limit?: number): Promise<number> {
  const key = embeddingJobKeySql(sql`n.id`, sql`n.seq`)
  let after: string | null = null
  let found = 0
  for (;;) {
    const batchSize = Math.min(catchUpLimits.batchSize, limit === undefined ? Infinity : limit - found)
    if (batchSize <= 0) break
    // An edited note keeps its previous blocks: a failed job for its current key counts too.
    const page = (await db.execute(sql`
      SELECT n.id FROM notes n
      WHERE n.deleted_at IS NULL ${after ? sql`AND n.id > ${after}::uuid` : sql``}
        AND ((NOT ${noteBlocksCurrentSql()} AND NOT ${jobExists(key)}) OR ${erroredJobExists(key)})
      ORDER BY n.id
      LIMIT ${batchSize}`)) as unknown as Array<{ id: string }>
    await enqueueEmbeddings(
      page.map((r) => r.id),
      'errored',
      JOB_PRIORITY.catchUp,
    )
    found += page.length
    if (page.length < batchSize) break
    after = page.at(-1)!.id
  }
  embedding.kick()
  return found
}

/**
 * Embedding state of the live notes of these vaults: `pending`, notes whose
 * embedding for their current `seq` is still to come (a pending job, or no
 * job and no blocks of its current seq, embedder and chunker: the boot
 * catch-up adds its job); `failed`, notes
 * whose job for their current `seq` gave up; `notes`, all of them. Search
 * reports it next to its results (#442).
 */
export async function embeddingState(vaultIds: string[]): Promise<{ notes: number; pending: number; failed: number }> {
  if (vaultIds.length === 0) return { notes: 0, pending: 0, failed: 0 }
  const [row] = (await db.execute(sql`
    SELECT count(*)::int AS notes,
      (count(*) FILTER (WHERE j.id IS NOT NULL AND j.done_at IS NULL OR j.id IS NULL AND NOT ${noteBlocksCurrentSql()}))::int AS pending,
      (count(*) FILTER (WHERE j.done_at IS NOT NULL AND j.last_error IS NOT NULL))::int AS failed
    FROM notes n
    LEFT JOIN jobs j ON j.idempotency_key = ${embeddingJobKeySql(sql`n.id`, sql`n.seq`)}
    WHERE n.vault_id = ANY(${`{${vaultIds.join(',')}}`}::uuid[]) AND n.deleted_at IS NULL`)) as unknown as [{ notes: number; pending: number; failed: number }]
  return row ?? { notes: 0, pending: 0, failed: 0 }
}

async function drainOnce(): Promise<void> {
  await failCrashedJobs(EMBEDDING_JOB, 'embedding', 'noteId')
  for (;;) {
    const job = await claimJob<{ noteId: string; seq?: number | string }>(EMBEDDING_JOB)
    if (!job) return
    const { noteId, seq } = job.payload
    try {
      await processNote(noteId, seq === undefined ? undefined : Number(seq))
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
 * Writes the note's block set for its `seq` (#452, #460; ADR-004 §2.5).
 * Skipped when the note is past `jobSeq`: the write that moved it queued the
 * newer seq's job. The blocks are computed and the new texts embedded outside
 * any transaction; a block whose `embedKey` (model + embedded text) one of
 * the note's blocks already has keeps that vector, so a frontmatter-only
 * edit embeds nothing and an edit in one section embeds that section's
 * block(s) only. One short transaction then locks the row, checks it is
 * still at the seq it read (an edit meanwhile moved it and queued that seq's
 * job, so this result is dropped), replaces the whole block set and records
 * `EMBEDDER_ID` and `CHUNK_VERSION` on the note.
 */
async function processNote(noteId: string, jobSeq: number | undefined): Promise<void> {
  const [row] = (await db.execute(sql`
    SELECT vault_id, path, body, seq FROM notes WHERE id = ${noteId} AND deleted_at IS NULL`)) as unknown as Array<{
    vault_id: string
    path: string
    body: string
    seq: string
  }>
  if (!row) return
  if (jobSeq !== undefined && Number(row.seq) > jobSeq) return
  const embedderId = EMBEDDER_ID
  const chunkVersion = CHUNK_VERSION

  const found = noteBlocks(noteId, row.path, row.body)
  const keys = found.map((b) => embedKey(b.embedText))
  const kept = await vectorsByEmbedKey('note', noteId)
  const vectors = keys.map((k) => kept.get(k) ?? null)
  const toEmbed = vectors.flatMap((v, i) => (v === null ? [i] : []))
  if (toEmbed.length > 0) {
    const embedded = await embedder.embed(toEmbed.map((i) => found[i]!.embedText))
    toEmbed.forEach((i, k) => {
      vectors[i] = embedded[k]!
    })
  }

  const rows = found.map((b, i) => ({
    ownerType: 'note' as const,
    ownerId: noteId,
    containerId: row.vault_id,
    blockId: b.blockId,
    kind: b.kind,
    innerPath: b.innerPath,
    startLine: b.startLine,
    endLine: b.endLine,
    contentHash: b.contentHash,
    ownerVersion: String(row.seq),
    embedKey: keys[i]!,
    embedding: vectors[i]!,
  }))
  const written = await db.transaction(async (tx) => {
    const [current] = (await tx.execute(sql`
      SELECT seq FROM notes WHERE id = ${noteId} AND deleted_at IS NULL FOR UPDATE`)) as unknown as Array<{ seq: string }>
    if (!current || String(current.seq) !== String(row.seq)) return false
    await replaceBlockSet(tx, 'note', noteId, rows)
    // Only when they differ: an UPDATE of the row recomputes its generated `fts`.
    await tx.execute(sql`UPDATE notes SET embedder_id = ${embedderId}, chunk_version = ${chunkVersion}
      WHERE id = ${noteId} AND (embedder_id IS DISTINCT FROM ${embedderId} OR chunk_version <> ${chunkVersion})`)
    return true
  })
  // The note's neighbours follow its block vectors: a set that only kept vectors it had (a frontmatter edit) has the
  // edges it had. Otherwise its own and those of the nodes it can move (#1007: the vectors new to it).
  const changed = toEmbed.length > 0 || [...kept.keys()].some((k) => !keys.includes(k))
  if (written && changed) await refreshSemanticEdges('note', noteId, toEmbed.map((i) => keys[i]!))
}
