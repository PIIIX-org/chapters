/**
 * Durable background jobs on the `jobs` table (ADR-003 §4, §7; S5 = #494).
 *
 * A job is one row: `kind`, `payload`, and an `idempotency_key` of the form
 * `<stage>:<item id>:<item version>[:<producer versions>]` (a repository
 * file's content hash, a note's `seq`; then the extractor version and the
 * embedder id that will produce the result, #453), so enqueueing the same
 * work twice is a no-op, a restart loses nothing, and new code that derives
 * differently gets new jobs. The table has no `run_after` column, so `lease_until` serves
 * both purposes: a job is claimable when it is not done and `lease_until` is
 * null or past. A claim sets it to now + `leaseMs` (a process that dies
 * mid-job leaves a lease that simply runs out); a failure sets it to now +
 * the backoff.
 *
 * States, derived from the row:
 * - pending: `done_at` null (running while `lease_until` is in the future and `attempts` > 0);
 * - done: `done_at` set, `last_error` null;
 * - failed: `done_at` set, `last_error` set — after `MAX_JOB_ATTEMPTS` claims.
 *
 * `attempts` counts claims, not failures, and a job is claimed only while
 * `attempts < MAX_JOB_ATTEMPTS`. A job whose runs keep killing the process
 * therefore stops at the maximum: `failCrashedJobs` marks it failed with a
 * `LeaseExpired` error once its last lease runs out, and reports it.
 */
import { sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { errorInfo, recordJob, type JobKind } from '../monitoring/metrics.js'
import { redactGitSecrets } from '../repositories/git-remote.js'

/** Claims per job before it is marked failed (documented in backend-reference.md). */
export const MAX_JOB_ATTEMPTS = 3

/** Mutable for tests only. */
export const jobTiming = {
  /** How long a claim holds a job; a dead process's jobs are claimable again after it. */
  leaseMs: 60_000,
  /**
   * Retry n waits `backoffBaseMs * 2^(n-1)`, at most `backoffMaxMs`: 1 min,
   * then 2 min, so an outage of up to about 3 minutes (a model download, a
   * database restart) does not fail the backlog.
   */
  backoffBaseMs: 60_000,
  backoffMaxMs: 2 * 60_000,
  /** Every drainer is woken this often, for backoffs and expired leases. */
  pollMs: 5_000,
}

/**
 * Boot catch-up enqueues in pages of this many items, one short statement
 * each (#453): a version bump on a large instance re-enqueues every file and
 * note without one transaction holding the whole backlog. Mutable for tests only.
 */
export const catchUpLimits = { batchSize: 1000 }

/**
 * `jobs.priority` (#453, migration 0033): claims take the lowest first, then
 * the oldest. A job a write queued (a note saved, a file pushed) goes before
 * the jobs a boot catch-up or `pnpm reindex` queued, so a version bump that
 * re-derives a whole instance never makes a new note wait for its vector.
 */
export const JOB_PRIORITY = { write: 0, catchUp: 1 } as const
export type JobPriority = (typeof JOB_PRIORITY)[keyof typeof JOB_PRIORITY]

/** Successfully finished jobs are deleted after this long (failed ones stay as the status). */
const DONE_RETENTION_DAYS = 7
const MAX_ERROR_LENGTH = 500
/** `last_error` prefix of a job whose last run ended with the process (see `failCrashedJobs`). */
const LEASE_EXPIRED = 'LeaseExpired'

export interface ClaimedJob<P> {
  id: number
  payload: P
  attempts: number
}

/**
 * Which finished job an enqueue of the same key runs again (a pending job is
 * always left as it is). `'never'`: none, a duplicate is a no-op.
 * `'succeeded'`: one that succeeded (an item changed back to an earlier
 * version). `'errored'`: one that failed with an error, not one whose runs
 * ended with the process (boot catch-up: an outage is over, a crash loop is
 * not retried at every boot). `'finished'`: any (`pnpm reindex`).
 */
export type JobRerun = 'never' | 'succeeded' | 'errored' | 'finished'

/** True for a finished job (row alias `job`) that failed with an error, not as `LeaseExpired`. */
function erroredJob(job: SQL): SQL {
  return sql`${job}.done_at IS NOT NULL AND ${job}.last_error IS NOT NULL AND ${job}.last_error NOT LIKE ${`${LEASE_EXPIRED}:%`}`
}

/**
 * Boot catch-up condition: the job with idempotency key `key` failed with an
 * error (see `JobRerun` `'errored'`), so the item's current version has no
 * result yet even when an earlier version left an embedding.
 */
export function erroredJobExists(key: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM jobs j WHERE j.idempotency_key = ${key} AND ${erroredJob(sql`j`)})`
}

/**
 * Boot catch-up condition: a job with idempotency key `key` exists, in any
 * state (#453): an item derived by other versions needs a job only when
 * there is none for the current ones (a pending one runs, an errored one is
 * matched by `erroredJobExists`, a `LeaseExpired` one stays failed).
 */
export function jobExists(key: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM jobs j WHERE j.idempotency_key = ${key})`
}

/**
 * The ON CONFLICT clause of an enqueue. The caller passes each key once:
 * Postgres refuses to update one row twice in a statement. A job run again
 * gets a new id, so it queues behind the jobs already pending.
 */
export function onJobConflict(rerun: JobRerun): SQL {
  if (rerun === 'never') return sql`ON CONFLICT (idempotency_key) DO NOTHING`
  const which = {
    succeeded: sql`AND jobs.last_error IS NULL`,
    errored: sql`AND ${erroredJob(sql`jobs`)}`,
    finished: sql``,
  }[rerun]
  // A job run again takes the priority of the enqueue that runs it.
  return sql`ON CONFLICT (idempotency_key) DO UPDATE
    SET id = nextval(pg_get_serial_sequence('jobs', 'id')), done_at = NULL, attempts = 0, last_error = NULL, lease_until = NULL,
      priority = EXCLUDED.priority
    WHERE jobs.done_at IS NOT NULL ${which}`
}

/**
 * Marks failed the jobs of `kind` that used their last claim and whose lease
 * ran out: their runs ended with the process (out of memory, a crash), so no
 * `failJob` recorded them. One monitoring report each, with `subjectField` of
 * the payload as the subject. Call before claiming. Returns the jobs failed.
 */
export async function failCrashedJobs(kind: string, monitoringKind: JobKind, subjectField: string): Promise<number> {
  const message = `${LEASE_EXPIRED}: the process running this job stopped before it finished, ${MAX_JOB_ATTEMPTS} times`
  const rows = (await db.execute(sql`
    UPDATE jobs SET done_at = now(), lease_until = NULL, last_error = ${message}
    WHERE kind = ${kind} AND done_at IS NULL AND attempts >= ${MAX_JOB_ATTEMPTS} AND lease_until < now()
    RETURNING payload->>${subjectField} AS subject`)) as unknown as Array<{ subject: string | null }>
  for (const row of rows) {
    console.error(`[jobs] ${kind} job for ${row.subject} failed: ${message}`)
    recordJob(monitoringKind, { error: { name: LEASE_EXPIRED } }, row.subject)
  }
  return rows.length
}

/** Claims the claimable job of `kind` (optionally narrowed by `filter` on `payload`) with the lowest priority, then the oldest. */
export async function claimJob<P>(kind: string, filter?: SQL): Promise<ClaimedJob<P> | null> {
  const rows = (await db.execute(sql`
    UPDATE jobs SET lease_until = now() + ${jobTiming.leaseMs} * interval '1 millisecond', attempts = attempts + 1
    WHERE id = (
      SELECT id FROM jobs
      WHERE kind = ${kind} AND done_at IS NULL AND (lease_until IS NULL OR lease_until < now())
        AND attempts < ${MAX_JOB_ATTEMPTS} ${filter ? sql`AND ${filter}` : sql``}
      ORDER BY priority, id LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, payload, attempts`)) as unknown as Array<{ id: string | number; payload: P; attempts: number }>
  const row = rows[0]
  return row ? { id: Number(row.id), payload: row.payload, attempts: row.attempts } : null
}

export async function completeJob(id: number): Promise<void> {
  await db.execute(sql`UPDATE jobs SET done_at = now(), lease_until = NULL, last_error = NULL WHERE id = ${id}`)
}

/**
 * Records a failed attempt: `last_error` (error name and message, credentials
 * in URLs redacted, cut to 500 characters; for an error with an `Error` cause,
 * such as Drizzle's "Failed query: <SQL>" around a Postgres error, those of
 * the cause), then a backoff, or `done_at` once
 * `MAX_JOB_ATTEMPTS` is reached. Monitoring gets one report when the job
 * gives up; earlier failures only count as repeats. Returns true when it gave up.
 */
export async function failJob(
  job: ClaimedJob<unknown>,
  err: unknown,
  monitoringKind: JobKind,
  subjectId: string,
): Promise<boolean> {
  const source = err instanceof Error && err.cause instanceof Error ? err.cause : err
  const message = source instanceof Error ? source.message : String(source)
  const lastError = `${errorInfo(source).name ?? 'Error'}: ${redactGitSecrets(message, [])}`.slice(0, MAX_ERROR_LENGTH)
  const final = job.attempts >= MAX_JOB_ATTEMPTS
  const backoffMs = Math.min(jobTiming.backoffBaseMs * 2 ** (job.attempts - 1), jobTiming.backoffMaxMs)
  await db.execute(sql`
    UPDATE jobs SET last_error = ${lastError},
      done_at = ${final ? sql`now()` : sql`NULL`},
      lease_until = ${final ? sql`NULL` : sql`now() + ${backoffMs} * interval '1 millisecond'`}
    WHERE id = ${job.id}`)
  recordJob(monitoringKind, { error: err, repeat: !final }, subjectId)
  return final
}

/** Deletes successfully finished jobs of `kinds` older than the retention. Returns rows deleted. */
export async function pruneFinishedJobs(kinds: string[]): Promise<number> {
  const rows = await db.execute(sql`
    DELETE FROM jobs
    WHERE kind IN (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)})
      AND done_at < now() - ${DONE_RETENTION_DAYS} * interval '1 day' AND last_error IS NULL
    RETURNING id`)
  return (rows as unknown as unknown[]).length
}

export interface JobDrainer {
  /** Starts a drain, or makes the running one look again before it stops. */
  kick(): void
  /** Runs an enqueue without blocking the caller (perf rule 2); `flush()` awaits it, then drains. */
  track(enqueue: Promise<unknown>): void
  /** Waits until tracked enqueues and the drain are finished — tests and batch scripts. */
  flush(): Promise<void>
}

const drainers: JobDrainer[] = []

/** One in-process worker per job kind: `drainOnce` claims and runs jobs until none is claimable. */
export function jobDrainer(name: string, drainOnce: () => Promise<void>): JobDrainer {
  let wanted = false
  let running: Promise<void> | null = null
  const inflight = new Set<Promise<unknown>>()
  async function loop(): Promise<void> {
    try {
      while (wanted) {
        wanted = false
        try {
          await drainOnce()
        } catch (err) {
          // A database outage: the jobs stay in the table; the next poll retries.
          console.error(`[jobs] ${name} drain failed:`, err)
        }
      }
    } finally {
      // Same synchronous step as the `wanted` check: a kick in between cannot be lost.
      running = null
    }
  }
  const drainer: JobDrainer = {
    kick() {
      wanted = true
      running ??= loop()
    },
    track(enqueue) {
      const p = enqueue
        .then(() => drainer.kick())
        .catch((err: unknown) => console.error(`[jobs] ${name} enqueue failed:`, err))
        .finally(() => inflight.delete(p))
      inflight.add(p)
    },
    async flush() {
      while (inflight.size > 0 || running) await Promise.all([...inflight, running])
    },
  }
  drainers.push(drainer)
  return drainer
}

/** Wakes every drainer every `pollMs`: backoffs that ran out, leases a dead process left. */
export function startJobPolling(): void {
  setInterval(() => {
    for (const d of drainers) d.kick()
  }, jobTiming.pollMs).unref()
}
