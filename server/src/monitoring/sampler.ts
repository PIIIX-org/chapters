// The timer behind the sampled gauges of GET /api/admin/metrics: every
// SAMPLE_INTERVAL_MS it reads process memory and the event-loop delay
// histogram (metrics.ts) and counts the pending rows of `jobs` per kind, one
// index-only scan of `jobs_pending` (schema.ts). Started by index.ts after
// the job pollers; scrapes read the last sample and never touch the database.
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { sampleEventLoop, sampleProcessMemory, setJobQueue, startEventLoopMonitor, stopEventLoopMonitor, type JobQueueDepth } from './metrics.js'

export const SAMPLE_INTERVAL_MS = 15_000

/** The pending jobs per kind (`done_at IS NULL`: queued, running or in backoff) and the age of each kind's oldest. */
export async function jobQueueDepths(): Promise<JobQueueDepth[]> {
  const rows = (await db.execute(sql`
    SELECT kind, count(*)::int AS pending, extract(epoch FROM now() - min(created_at))::float8 AS oldest
    FROM jobs WHERE done_at IS NULL GROUP BY kind`)) as unknown as Array<{ kind: string; pending: number; oldest: number | string }>
  return rows.map((r) => ({ kind: r.kind, pending: r.pending, oldestAgeSeconds: Number(r.oldest) }))
}

/** One sample of every gauge; a failed queue read keeps the previous queue sample and logs the error's name. */
export async function sampleOnce(now = Date.now()): Promise<void> {
  sampleProcessMemory(now)
  sampleEventLoop(now)
  try {
    setJobQueue(await jobQueueDepths(), now)
  } catch (err) {
    console.warn('[metrics] job queue sample failed:', err instanceof Error ? err.name : err)
  }
}

/** Starts the event-loop monitor and the sampling timer (unref'd); returns the stop function. */
export function startMetricsSampler(intervalMs = SAMPLE_INTERVAL_MS): () => void {
  startEventLoopMonitor()
  void sampleOnce()
  const timer = setInterval(() => void sampleOnce(), intervalMs).unref()
  return () => {
    clearInterval(timer)
    stopEventLoopMonitor()
  }
}
