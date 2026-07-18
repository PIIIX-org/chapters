import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db } from '../src/db/client.js'
import { repositories } from '../src/db/schema.js'
import { listRepositoryFiles } from '../src/repositories/store.js'
import { startWatching } from '../src/repositories/local-watch.js'
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

async function makeRepo() {
  const owner = await createActiveUser()
  const [repo] = await db
    .insert(repositories)
    .values({ name: 'watch-test', ownerId: owner.id, ingestionMethod: 'local_path' })
    .returning()
  return repo!
}

describe('local path ingestion', () => {
  it('syncs existing files, then live changes, then stops on unsubscribe', async () => {
    dir = await mkdtemp(join(tmpdir(), 'chapters-watch-'))
    await writeFile(join(dir, 'a.py'), 'print(1)')
    await mkdir(join(dir, 'node_modules'))
    await writeFile(join(dir, 'node_modules', 'noise.py'), 'ignored')

    const repo = await makeRepo()
    stop = startWatching(repo.id, dir)

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
})
