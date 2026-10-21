// ADR-003 S5 (#494): a failing job is retried with attempts++, then stops at
// MAX_JOB_ATTEMPTS with its last error stored and one monitoring report.
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { jobs, repositories, repositoryFiles } from '../src/db/schema.js'
import { MAX_JOB_ATTEMPTS, jobTiming } from '../src/jobs/durable.js'
import { flushExtraction, scheduleExtraction } from '../src/repositories/extraction-queue.js'
import { embedder } from '../src/search/embeddings.js'
import { metricsSnapshot } from '../src/monitoring/metrics.js'
import { createActiveUser } from './helpers.js'

const savedBackoff = jobTiming.backoffBaseMs
beforeEach(() => {
  // Retries become claimable at once, so one flush runs every attempt.
  jobTiming.backoffBaseMs = 0
})
afterEach(() => {
  jobTiming.backoffBaseMs = savedBackoff
  vi.restoreAllMocks()
})

describe('durable job retries (#494)', () => {
  it('retries a failing extraction with attempts++ and stops at the maximum with last_error', async () => {
    const owner = await createActiveUser()
    const [repo] = await db
      .insert(repositories)
      .values({ name: 'jobs-retry', ownerId: owner.id, ingestionMethod: 'agent_push' })
      .returning()
    const content = 'always fails'
    const contentHash = createHash('sha256').update(content).digest('hex')
    const [file] = await db
      .insert(repositoryFiles)
      .values({ repositoryId: repo!.id, path: 'fail.txt', language: null, content, contentHash, size: content.length })
      .returning()
    let calls = 0
    vi.spyOn(embedder, 'embed').mockImplementation(async () => {
      calls++
      throw new Error(`Synthetic embedder failure ${calls}`)
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failedBefore = metricsSnapshot().jobs.extraction.failed

    scheduleExtraction(file!.id, repo!.id)
    await flushExtraction()

    expect(calls).toBe(MAX_JOB_ATTEMPTS)
    const [job] = await db.select().from(jobs).where(eq(jobs.idempotencyKey, `extract:${file!.id}:${contentHash}`))
    expect(job?.attempts).toBe(MAX_JOB_ATTEMPTS)
    expect(job?.doneAt).not.toBeNull()
    expect(job?.lastError).toBe(`Error: Synthetic embedder failure ${MAX_JOB_ATTEMPTS}`)
    // Reported once, when it gives up; the earlier failures count as repeats.
    expect(metricsSnapshot().jobs.extraction.failed).toBe(failedBefore + 1)

    // Stopped: another enqueue of the same content does not run it again.
    scheduleExtraction(file!.id, repo!.id)
    await flushExtraction()
    expect(calls).toBe(MAX_JOB_ATTEMPTS)
  })
})
