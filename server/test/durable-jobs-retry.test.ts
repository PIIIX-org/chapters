// ADR-003 S5 (#494): a failing job is retried with attempts++, then stops at
// MAX_JOB_ATTEMPTS with its last error stored and one monitoring report.
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { jobs, notes, repositories, repositoryFiles, vaults } from '../src/db/schema.js'
import { MAX_JOB_ATTEMPTS, jobTiming } from '../src/jobs/durable.js'
import {
  countPendingExtractions,
  extractionJobKey,
  extractionFailures,
  flushExtraction,
  scheduleExtraction,
  scheduleMissingExtractions,
} from '../src/repositories/extraction-queue.js'
import { embeddingJobKey, flushEmbeddings, scheduleMissingEmbeddings } from '../src/search/embedding-queue.js'
import { embedder } from '../src/search/embeddings.js'
import { metricsSnapshot } from '../src/monitoring/metrics.js'
import { createActiveUser, fileEmbedding } from './helpers.js'

const savedBackoff = jobTiming.backoffBaseMs
beforeEach(() => {
  // Retries become claimable at once, so one flush runs every attempt.
  jobTiming.backoffBaseMs = 0
})
const createdVaultIds: string[] = []
afterEach(async () => {
  jobTiming.backoffBaseMs = savedBackoff
  vi.restoreAllMocks()
  for (const id of createdVaultIds.splice(0)) await db.delete(vaults).where(eq(vaults.id, id))
})

/** A repository file persisted by a sync whose extraction never ran. */
async function unextractedFile(name: string, content = `plain text of ${name}`) {
  const owner = await createActiveUser()
  const [repo] = await db
    .insert(repositories)
    .values({ name, ownerId: owner.id, ingestionMethod: 'agent_push' })
    .returning()
  const contentHash = createHash('sha256').update(content).digest('hex')
  const [file] = await db
    .insert(repositoryFiles)
    .values({ repositoryId: repo!.id, path: `${name}.txt`, language: null, content, contentHash, size: content.length })
    .returning()
  return { repo: repo!, file: file!, key: extractionJobKey(file!.id, contentHash) }
}

async function jobByKey(key: string) {
  return (await db.select().from(jobs).where(eq(jobs.idempotencyKey, key)))[0]
}

/** Seconds from now (database clock) until the job is claimable again. */
async function secondsUntilClaimable(key: string): Promise<number> {
  const [row] = (await db.execute(
    sql`SELECT extract(epoch FROM lease_until - now())::float AS s FROM jobs WHERE idempotency_key = ${key}`,
  )) as unknown as [{ s: number }]
  return row.s
}

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

    scheduleExtraction(file!.id)
    await flushExtraction()

    expect(calls).toBe(MAX_JOB_ATTEMPTS)
    const [job] = await db.select().from(jobs).where(eq(jobs.idempotencyKey, extractionJobKey(file!.id, contentHash)))
    expect(job?.attempts).toBe(MAX_JOB_ATTEMPTS)
    expect(job?.doneAt).not.toBeNull()
    expect(job?.lastError).toBe(`Error: Synthetic embedder failure ${MAX_JOB_ATTEMPTS}`)
    // Reported once, when it gives up; the earlier failures count as repeats.
    expect(metricsSnapshot().jobs.extraction.failed).toBe(failedBefore + 1)

    // Stopped: another enqueue of the same content does not run it again.
    scheduleExtraction(file!.id)
    await flushExtraction()
    expect(calls).toBe(MAX_JOB_ATTEMPTS)
  })
})

describe('durable job limits (#494 review)', () => {
  it('a job whose runs keep killing the process stops at the maximum and is reported, also across boots', async () => {
    const { repo, file, key } = await unextractedFile('jobs-crash-loop')
    // What MAX_JOB_ATTEMPTS runs that each took the process down leave behind.
    await db.insert(jobs).values({
      kind: 'extract',
      payload: { fileId: file.id, repositoryId: repo.id },
      idempotencyKey: key,
      attempts: MAX_JOB_ATTEMPTS,
      leaseUntil: new Date(Date.now() - 1000),
    })
    let calls = 0
    const embed = embedder.embed.bind(embedder)
    vi.spyOn(embedder, 'embed').mockImplementation(async (texts) => {
      if (texts[0]!.startsWith(`${file.path}\n`)) calls++
      return embed(texts)
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failedBefore = metricsSnapshot().jobs.extraction.failed

    // Boot, twice: the second boot's catch-up scan must not re-arm it either.
    for (let boot = 0; boot < 2; boot++) {
      await scheduleMissingExtractions()
      await flushExtraction()
    }

    expect(calls).toBe(0)
    const job = await jobByKey(key)
    expect(job?.attempts).toBe(MAX_JOB_ATTEMPTS)
    expect(job?.doneAt).not.toBeNull()
    expect(job?.lastError).toMatch(/^LeaseExpired: /)
    expect(metricsSnapshot().jobs.extraction.failed).toBe(failedBefore + 1)
    expect((await extractionFailures(repo.id)).total).toBe(1)
  })

  it('retries over minutes, and a restart repairs a file whose job failed during an embedder outage', async () => {
    jobTiming.backoffBaseMs = savedBackoff
    const { repo, file, key } = await unextractedFile('jobs-outage')
    const outage = vi.spyOn(embedder, 'embed').mockRejectedValue(new Error('model download failed'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    scheduleExtraction(file.id)
    await flushExtraction()
    expect((await jobByKey(key))?.attempts).toBe(1)
    // First retry after about a minute, the last one after backoffMaxMs.
    expect(await secondsUntilClaimable(key)).toBeGreaterThan(55)
    for (let attempt = 2; attempt <= MAX_JOB_ATTEMPTS; attempt++) {
      await db.update(jobs).set({ leaseUntil: new Date(Date.now() - 1000) }).where(eq(jobs.idempotencyKey, key))
      scheduleExtraction(file.id) // a pending job is left as it is; this only wakes the worker
      await flushExtraction()
      expect((await jobByKey(key))?.attempts).toBe(attempt)
      if (attempt < MAX_JOB_ATTEMPTS) expect(await secondsUntilClaimable(key)).toBeGreaterThan(jobTiming.backoffMaxMs / 1000 - 5)
    }
    const failed = await jobByKey(key)
    expect(failed?.doneAt).not.toBeNull()
    expect(failed?.lastError).toBe('Error: model download failed')
    expect(jobTiming.backoffMaxMs).toBeGreaterThanOrEqual(120_000)
    // Failed is not pending: extraction of this repository is finished, with one failure.
    expect(await countPendingExtractions(repo.id)).toBe(0)
    expect((await extractionFailures(repo.id)).total).toBe(1)

    // The embedder is back; the next boot's catch-up scan re-runs the failed job.
    outage.mockRestore()
    await scheduleMissingExtractions()
    await flushExtraction()
    const repaired = await jobByKey(key)
    expect(repaired?.doneAt).not.toBeNull()
    expect(repaired?.lastError).toBeNull()
    expect(await fileEmbedding(file.id)).not.toBeNull()
    expect((await extractionFailures(repo.id)).total).toBe(0)
  })

  it('a restart re-embeds a note whose embedding job failed', async () => {
    const user = await createActiveUser()
    const [vault] = await db.insert(vaults).values({ name: 'jobs-outage-vault', ownerId: user.id }).returning()
    createdVaultIds.push(vault!.id)
    const [note] = await db
      .insert(notes)
      .values({ vaultId: vault!.id, type: 'note', name: 'n', path: `outage-${Date.now()}.md`, body: 'outage', frontmatter: {} })
      .returning()
    const [{ seq }] = (await db.execute(sql`SELECT seq FROM notes WHERE id = ${note!.id}`)) as unknown as [{ seq: string }]
    const key = embeddingJobKey(note!.id, seq)
    await db.insert(jobs).values({
      kind: 'embed_note',
      payload: { noteId: note!.id, seq: Number(seq) },
      idempotencyKey: key,
      attempts: MAX_JOB_ATTEMPTS,
      lastError: 'Error: model download failed',
      doneAt: new Date(),
    })

    await scheduleMissingEmbeddings()
    await flushEmbeddings()

    const [row] = await db.select().from(notes).where(eq(notes.id, note!.id))
    expect(row?.embedding).not.toBeNull()
    expect((await jobByKey(key))?.lastError).toBeNull()
  })

  it('last_error keeps the database cause, not the failed query text', async () => {
    const { file, key } = await unextractedFile('jobs-db-cause')
    const cause = Object.assign(new Error('deadlock detected'), { name: 'PostgresError' })
    vi.spyOn(embedder, 'embed').mockRejectedValue(
      new Error(`Failed query: update "repository_files" set "embedding" = $1 ${'x'.repeat(600)}`, { cause }),
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})

    scheduleExtraction(file.id)
    await flushExtraction()

    expect((await jobByKey(key))?.lastError).toBe('PostgresError: deadlock detected')
  })
})

describe('boot re-runs failed jobs of the current version (#494 review round 2)', () => {
  it('a file that kept its old embedding and failed on its new content is re-extracted at the next boot', async () => {
    const { repo, file } = await unextractedFile('jobs-v2-failure', 'version one')
    // Version 1 extracted: the file has an embedding.
    scheduleExtraction(file.id)
    await flushExtraction()
    // Version 2 pushed; its extraction fails until the embedder is back.
    const v2 = 'version two'
    const v2Hash = createHash('sha256').update(v2).digest('hex')
    await db.update(repositoryFiles).set({ content: v2, contentHash: v2Hash, size: v2.length }).where(eq(repositoryFiles.id, file.id))
    const key = extractionJobKey(file.id, v2Hash)
    await db.insert(jobs).values({
      kind: 'extract',
      payload: { fileId: file.id, repositoryId: repo.id },
      idempotencyKey: key,
      attempts: MAX_JOB_ATTEMPTS,
      lastError: 'Error: model download failed',
      doneAt: new Date(),
    })
    expect(await fileEmbedding(file.id)).not.toBeNull()
    let calls = 0
    const embed = embedder.embed.bind(embedder)
    vi.spyOn(embedder, 'embed').mockImplementation(async (texts) => {
      if (texts[0] === `${file.path}\n${v2}`) calls++
      return embed(texts)
    })

    await scheduleMissingExtractions()
    await flushExtraction()

    expect(calls).toBe(1)
    const job = await jobByKey(key)
    expect(job?.doneAt).not.toBeNull()
    expect(job?.lastError).toBeNull()
    expect((await extractionFailures(repo.id)).total).toBe(0)
  })

  it('a note that kept its old embedding and failed on its new version is re-embedded at the next boot', async () => {
    const user = await createActiveUser()
    const [vault] = await db.insert(vaults).values({ name: 'jobs-v2-vault', ownerId: user.id }).returning()
    createdVaultIds.push(vault!.id)
    const [note] = await db
      .insert(notes)
      .values({ vaultId: vault!.id, type: 'note', name: 'n', path: `v2-${Date.now()}.md`, body: 'version one', frontmatter: {} })
      .returning()
    await db.update(notes).set({ embedding: new Array(384).fill(0.1) }).where(eq(notes.id, note!.id))
    await db.update(notes).set({ body: 'version two' }).where(eq(notes.id, note!.id))
    const [{ seq }] = (await db.execute(sql`SELECT seq FROM notes WHERE id = ${note!.id}`)) as unknown as [{ seq: string }]
    const key = embeddingJobKey(note!.id, seq)
    await db.insert(jobs).values({
      kind: 'embed_note',
      payload: { noteId: note!.id, seq: Number(seq) },
      idempotencyKey: key,
      attempts: MAX_JOB_ATTEMPTS,
      lastError: 'Error: model download failed',
      doneAt: new Date(),
    })

    await scheduleMissingEmbeddings()
    await flushEmbeddings()

    const job = await jobByKey(key)
    expect(job?.lastError).toBeNull()
    expect(job?.doneAt).not.toBeNull()
  })
})
