import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleGit, type SimpleGit } from 'simple-git'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { repositories } from '../src/db/schema.js'
import { syncGitRepository } from '../src/repositories/git-sync.js'
import type * as GitSync from '../src/repositories/git-sync.js'
import { startPollingScheduler } from '../src/repositories/scheduler.js'
import { getRepositoryFile } from '../src/repositories/store.js'
import { createActiveUser } from './helpers.js'

// The poller walks every git repository in the shared test database. Rows
// left by other test files point at unreachable remotes, so only the
// repositories created here run the real sync; every call is recorded.
const { pollable, polled } = vi.hoisted(() => ({ pollable: new Set<string>(), polled: [] as string[] }))
vi.mock('../src/repositories/git-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof GitSync>()
  return {
    ...actual,
    syncGitRepository: async (...args: Parameters<typeof actual.syncGitRepository>) => {
      polled.push(args[0])
      if (pollable.has(args[0])) await actual.syncGitRepository(...args)
    },
  }
})
const THRESHOLD = 10 * 60 * 1000
// The real interval loop is what is under test, so it runs on the real clock.
const INTERVAL = 100

let dirs: string[] = []
let stop: (() => void) | null = null
afterEach(async () => {
  stop?.()
  stop = null
  pollable.clear()
  polled.length = 0
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
  dirs = []
})

interface Remote {
  remoteUrl: string
  workDir: string
  git: SimpleGit
}

async function makeRemote(): Promise<Remote> {
  const bareDir = await mkdtemp(join(tmpdir(), 'elara-poll-bare-'))
  const workDir = await mkdtemp(join(tmpdir(), 'elara-poll-work-'))
  dirs.push(bareDir, workDir)
  await simpleGit(bareDir).init(true)
  // Pin HEAD so a --depth 1 clone finds the branch whatever git's default is.
  await simpleGit(bareDir).raw(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  const git = simpleGit(workDir)
  await git.init()
  await git.addConfig('user.email', 'test@elara.local')
  await git.addConfig('user.name', 'Test')
  await git.addRemote('origin', bareDir)
  return { remoteUrl: `file://${bareDir}`, workDir, git }
}

async function commitAndPush(remote: Remote, file: string, content: string) {
  await writeFile(join(remote.workDir, file), content)
  await remote.git.add('.')
  await remote.git.commit(`add ${file}`)
  await remote.git.push('origin', 'HEAD:refs/heads/main')
}

async function makeWebhookRepo(gitUrl: string) {
  const owner = await createActiveUser()
  const [repo] = await db
    .insert(repositories)
    .values({ name: 'poll-test', ownerId: owner.id, ingestionMethod: 'git', gitUrl })
    .returning()
  return repo!
}

// waitFor gives up (an assertion failure) well before the test timeout.
describe('polling scheduler and webhooks (#410)', () => {
  it('polls a repository whose last webhook synced successfully but is now stale', async () => {
    const remote = await makeRemote()
    await commitAndPush(remote, 'a.md', 'first')
    const repo = await makeWebhookRepo(remote.remoteUrl)
    pollable.add(repo.id)

    // What a webhook does: record the delivery, then sync. The sync finishes
    // after the delivery, so lastSyncedAt > lastWebhookAt. Then the hook goes
    // quiet (deleted, disabled, unreachable) for longer than the threshold.
    await syncGitRepository(repo.id)
    const now = Date.now()
    await db
      .update(repositories)
      .set({ lastWebhookAt: new Date(now - 20 * 60 * 1000), lastSyncedAt: new Date(now - 19 * 60 * 1000) })
      .where(eq(repositories.id, repo.id))
    expect(await getRepositoryFile(repo.id, 'a.md')).not.toBeNull()

    // A push the dead hook never announced.
    await commitAndPush(remote, 'b.md', 'second')
    polled.length = 0

    stop = startPollingScheduler(INTERVAL, THRESHOLD)
    await vi.waitFor(
      async () => {
        expect(polled).toContain(repo.id)
        expect((await getRepositoryFile(repo.id, 'b.md'))?.content).toBe('second')
      },
      { timeout: 8_000, interval: 50 },
    )
  })

  it('polls a repository whose recent webhook sync failed, and skips one whose recent webhook sync succeeded', async () => {
    const owner = await createActiveUser()
    const recent = new Date()
    const [failed, healthy] = await db
      .insert(repositories)
      .values([
        {
          name: 'poll-failed',
          ownerId: owner.id,
          ingestionMethod: 'git',
          gitUrl: 'file:///nonexistent/failed.git',
          lastWebhookAt: recent,
          syncStatus: 'error',
          lastSyncError: 'remote hung up',
        },
        {
          name: 'poll-healthy',
          ownerId: owner.id,
          ingestionMethod: 'git',
          gitUrl: 'file:///nonexistent/healthy.git',
          lastWebhookAt: recent,
          lastSyncedAt: new Date(recent.getTime() + 1000),
          syncStatus: 'idle',
        },
      ])
      .returning()

    stop = startPollingScheduler(INTERVAL, THRESHOLD)
    // Seen twice = at least one whole tick, which considered every candidate.
    await vi.waitFor(() => expect(polled.filter((id) => id === failed!.id).length).toBeGreaterThanOrEqual(2), {
      timeout: 8_000,
      interval: 50,
    })
    expect(polled).not.toContain(healthy!.id)
  })
})
