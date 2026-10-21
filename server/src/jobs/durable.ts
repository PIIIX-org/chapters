/**
 * Durable background jobs on the `jobs` table (ADR-003 §4, §7; S5 = #494).
 *
 * A job is one row: `kind`, `payload`, and an `idempotency_key` of the form
 * `<stage>:<item id>:<item version>` (a repository file's content hash, a
 * note's `seq`), so enqueueing the same work twice is a no-op and a restart
 * loses nothing. The table has no `run_after` column, so `lease_until` serves
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
 * `attempts` counts claims, not failures, so a job that kills the process
 * every time it runs also stops at the maximum.
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
  /** Retry n waits `backoffBaseMs * 2^(n-1)`, at most `backoffMaxMs`. */
  backoffBaseMs: 5_000,
  backoffMaxMs: 5 * 60_000,
  /** Every drainer is woken this often, for backoffs and expired leases. */
  pollMs: 5_000,
}

/** Successfully finished jobs are deleted after this long (failed ones stay as the status). */
const DONE_RETENTION_DAYS = 7
const MAX_ERROR_LENGTH = 500

export interface ClaimedJob<P> {
  id: number
  payload: P
  attempts: number
}

/**
 * The ON CONFLICT clause of an enqueue. `'never'`: a duplicate is a no-op.
 * `'succeeded'`: a job with this key that already finished successfully runs
 * again (an item changed back to an earlier version; pending and failed jobs
 * stay as they are). `'finished'`: any finished job runs again (`pnpm reindex`).
 */
export function onJobConflict(rerun: 'never' | 'succeeded' | 'finished'): SQL {
  if (rerun === 'never') return sql`ON CONFLICT (idempotency_key) DO NOTHING`
  return sql`ON CONFLICT (idempotency_key) DO UPDATE
    SET done_at = NULL, attempts = 0, last_error = NULL, lease_until = NULL
    WHERE jobs.done_at IS NOT NULL ${rerun === 'succeeded' ? sql`AND jobs.last_error IS NULL` : sql``}`
}

/** Claims the oldest claimable job of `kind` (optionally narrowed by `filter` on `payload`). */
export async function claimJob<P>(kind: string, filter?: SQL): Promise<ClaimedJob<P> | null> {
  const rows = (await db.execute(sql`
    UPDATE jobs SET lease_until = now() + ${jobTiming.leaseMs} * interval '1 millisecond', attempts = attempts + 1
    WHERE id = (
      SELECT id FROM jobs
      WHERE kind = ${kind} AND done_at IS NULL AND (lease_until IS NULL OR lease_until < now())
        ${filter ? sql`AND ${filter}` : sql``}
      ORDER BY id LIMIT 1
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
 * in URLs redacted, cut to 500 characters), then a backoff, or `done_at` once
 * `MAX_JOB_ATTEMPTS` is reached. Monitoring gets one report when the job
 * gives up; earlier failures only count as repeats. Returns true when it gave up.
 */
export async function failJob(
  job: ClaimedJob<unknown>,
  err: unknown,
  monitoringKind: JobKind,
  subjectId: string,
): Promise<boolean> {
  const message = err instanceof Error ? err.message : String(err)
  const lastError = `${errorInfo(err).name ?? 'Error'}: ${redactGitSecrets(message, [])}`.slice(0, MAX_ERROR_LENGTH)
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
