import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db } from '../src/db/client.js'
import { repositories } from '../src/db/schema.js'
import { listRepositoryFiles } from '../src/repositories/store.js'
import { startWatching } from '../src/repositories/local-watch.js'
import { syncLocalRepository } from '../src/repositories/scheduler.js'
import { createActiveUser } from './helpers.js'

async function waitFor(check: () => Promise<boolean>, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

let stop: (() => void) | null = null
let dir: string | null = null

afterEach(async () => {
  stop?.()
  stop = null
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = null
})

async function makeRepo(localPath: string) {
  const owner = await createActiveUser()
  const [repo] = await db
    .insert(repositories)
    .values({ name: 'watch-test', ownerId: owner.id, ingestionMethod: 'local_path', localPath })
    .returning()
  return repo!
}

describe('local path ingestion', () => {
  it('syncs existing files, then live changes, then stops on unsubscribe', async () => {
    dir = await mkdtemp(join(tmpdir(), 'chapters-watch-'))
    await writeFile(join(dir, 'a.py'), 'print(1)')
    await mkdir(join(dir, 'node_modules'))
    await writeFile(join(dir, 'node_modules', 'noise.py'), 'ignored')

    const repo = await makeRepo(dir)
    // Wired exactly as the scheduler wires it, so this exercises the real
    // status-tracked sync rather than a shape only the test uses.
    stop = startWatching(repo.id, dir, () => syncLocalRepository(repo.id))

    await waitFor(async () => (await listRepositoryFiles(repo.id)).length === 1)
    let files = await listRepositoryFiles(repo.id)
    expect(files.map((f) => f.path)).toEqual(['a.py'])

    await writeFile(join(dir, 'b.py'), 'print(2)')
    await waitFor(async () => (await listRepositoryFiles(repo.id)).length === 2)
    files = await listRepositoryFiles(repo.id)
    expect(files.map((f) => f.path).sort()).toEqual(['a.py', 'b.py'])

    await unlink(join(dir, 'a.py'))
    await waitFor(async () => (await listRepositoryFiles(repo.id)).length === 1)
    files = await listRepositoryFiles(repo.id)
    expect(files.map((f) => f.path)).toEqual(['b.py'])

    stop()
    stop = null
    await writeFile(join(dir, 'c.py'), 'print(3)')
    await new Promise((r) => setTimeout(r, 600))
    files = await listRepositoryFiles(repo.id)
    expect(files.map((f) => f.path).sort()).toEqual(['b.py'])
  }, 15000)
  it('survives a sync that throws instead of taking the process down with it', async () => {
    // runSync fires from a timer, so there is no caller to reject to: an error
    // inside it is an unhandled rejection, and Node terminates on those. Since
    // watchers are started at boot for every local_path repository, one folder
    // that has been deleted or unmounted would kill the server on startup.
    dir = await mkdtemp(join(tmpdir(), 'chapters-watch-fail-'))
    await writeFile(join(dir, 'a.py'), 'print(1)')

    const rejections: unknown[] = []
    const onRejection = (err: unknown) => rejections.push(err)
    process.on('unhandledRejection', onRejection)

    let calls = 0
    try {
      stop = startWatching('r-missing', dir, () => {
        calls += 1
        return Promise.reject(new Error('folder is gone'))
      })

      await waitFor(() => Promise.resolve(calls > 0))
      // Give any unhandled rejection a turn of the loop to surface.
      await new Promise((r) => setTimeout(r, 100))
      expect(rejections).toEqual([])

      // Still watching: the next change gets another chance.
      const before = calls
      await writeFile(join(dir, 'b.py'), 'print(2)')
      await waitFor(() => Promise.resolve(calls > before))
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })
})
