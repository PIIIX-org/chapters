import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type * as SimpleGit from 'simple-git'
import { eq } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { repositories } from '../src/db/schema.js'
import { encryptCredential } from '../src/repositories/credentials.js'
import { syncGitRepository } from '../src/repositories/git-sync.js'
import { metricsSnapshot } from '../src/monitoring/metrics.js'
import { createActiveUser } from './helpers.js'

// #775: a poll (`tick` in scheduler.ts) and a webhook delivery can sync the
// same repository at once. Whichever starts second used to read the
// `syncing` the first one wrote instead of the status before it, so a
// repository already in `error` failing again was counted as a new failure:
// a report and an alert (#705) for a failure that was already alerted.
//
// The remote is a stand-in: every clone blocks until the test opens the gate,
// then fails, so the second sync provably starts while the first is cloning.
const remote = vi.hoisted(() => ({ clones: 0, open: (): void => {}, opened: Promise.resolve() }))
vi.mock('simple-git', async (importOriginal) => {
  const actual = await importOriginal<typeof SimpleGit>()
  return {
    ...actual,
    simpleGit: () => ({
      listRemote: async () => {
        throw new Error('ls-remote: the remote end hung up')
      },
      clone: async () => {
        remote.clones++
        await remote.opened
        throw new Error('clone: the remote end hung up')
      },
    }),
  }
})

let app: FastifyInstance
beforeAll(async () => {
  app = await buildApp()
  await app.ready()
})
afterAll(async () => app.close())

// The server's TypeScript lib (ES2023) predates Promise.withResolvers, so the executor form.
beforeEach(() => {
  remote.clones = 0
  remote.opened = new Promise<void>((resolve) => {
    remote.open = resolve
  })
})

const SECRET = 'overlap-webhook-secret'

async function makeRepo(state: { syncStatus: 'idle' | 'error'; lastSyncError: string | null }) {
  const owner = await createActiveUser()
  const [repo] = await db
    .insert(repositories)
    .values({
      name: 'sync-overlap',
      ownerId: owner.id,
      ingestionMethod: 'git',
      gitUrl: 'file:///nonexistent/overlap.git',
      webhookSecretEncrypted: encryptCredential(SECRET),
      ...state,
    })
    .returning()
  return repo!
}

async function deliverWebhook(repositoryId: string): Promise<void> {
  const body = JSON.stringify({ ref: 'refs/heads/main' })
  const res = await app.inject({
    method: 'POST',
    url: `/repositories/${repositoryId}/webhook`,
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
    },
    payload: body,
  })
  expect(res.statusCode).toBe(200)
}

const syncJobs = () => metricsSnapshot().jobs.sync
const recordsFor = (repositoryId: string) =>
  metricsSnapshot().errors.filter((e) => e.type === 'job' && e.subjectId === repositoryId)
const syncStatus = async (repositoryId: string) =>
  (await db.select().from(repositories).where(eq(repositories.id, repositoryId)))[0]!.syncStatus

/**
 * A poll sync is cloning when a webhook delivery arrives; both clones fail.
 * Resolves once both outcomes are counted.
 */
async function overlapPollAndWebhook(repositoryId: string): Promise<void> {
  const before = syncJobs()
  // What the poller does for each candidate.
  const poll = syncGitRepository(repositoryId)
  await vi.waitFor(() => expect(remote.clones).toBe(1), { timeout: 5_000, interval: 10 })
  expect(await syncStatus(repositoryId)).toBe('syncing')
  await deliverWebhook(repositoryId)
  // The webhook's sync runs fire-and-forget: let it read the row and start
  // its own clone while the poll's is still blocked.
  await vi.waitFor(() => expect(remote.clones).toBe(2), { timeout: 5_000, interval: 10 })
  remote.open()
  await expect(poll).rejects.toThrow('the remote end hung up')
  await vi.waitFor(
    async () => {
      const now = syncJobs()
      expect(now.failed + now.repeated - before.failed - before.repeated).toBe(2)
      expect(await syncStatus(repositoryId)).toBe('error')
    },
    { timeout: 5_000, interval: 20 },
  )
}

describe('overlapping poll and webhook syncs of one repository (#775)', () => {
  it('a repository already in error that fails in both counts two repeats and no new failure', async () => {
    const repo = await makeRepo({ syncStatus: 'error', lastSyncError: 'clone: the remote end hung up' })
    const before = metricsSnapshot()

    await overlapPollAndWebhook(repo.id)

    const after = metricsSnapshot()
    expect(after.jobs.sync.failed).toBe(before.jobs.sync.failed)
    expect(after.jobs.sync.repeated).toBe(before.jobs.sync.repeated + 2)
    expect(after.totals.jobFailures).toBe(before.totals.jobFailures)
    expect(recordsFor(repo.id)).toHaveLength(0)
  })

  it('a healthy repository that fails in both counts one new failure, the other as its repeat', async () => {
    const repo = await makeRepo({ syncStatus: 'idle', lastSyncError: null })
    const before = metricsSnapshot()

    await overlapPollAndWebhook(repo.id)

    const after = metricsSnapshot()
    expect(after.jobs.sync.failed).toBe(before.jobs.sync.failed + 1)
    expect(after.jobs.sync.repeated).toBe(before.jobs.sync.repeated + 1)
    expect(after.totals.jobFailures).toBe(before.totals.jobFailures + 1)
    expect(recordsFor(repo.id)).toHaveLength(1)
  })
})
