import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { repositories, repositoryFileSymbols } from '../src/db/schema.js'
import { syncGitRepository } from '../src/repositories/git-sync.js'
import { syncLocalRepository } from '../src/repositories/scheduler.js'
import { getRepositoryFile, syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { findSymbols, searchNotes } from '../src/search/search.js'
import { createActiveUser } from './helpers.js'

// #923: a file that grows past the 1 MB cap or gains a NUL byte used to keep
// its old row, because the sync skipped it but still listed its path as
// current. read_file, search and symbols then served the old version forever.

const TOKEN = 'staleQuasarBeacon'
const ORIGINAL = `export function ${TOKEN}() { return 1 }\n`
const OVERSIZED = `${ORIGINAL}// ${'x'.repeat(1_100_000)}\n`
const WITH_NUL = `${ORIGINAL}const tail = 'a\0b'\n`

let dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
  dirs = []
})

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function makeRepo(values: { ingestionMethod: 'git' | 'local_path' | 'agent_push'; gitUrl?: string; localPath?: string }) {
  const owner = await createActiveUser()
  const [repo] = await db
    .insert(repositories)
    .values({ name: 'skipped-file-test', ownerId: owner.id, ...values })
    .returning()
  return repo!
}

/** Indexed: read_file's row, a search hit and the symbol are all there. */
async function expectIndexed(repositoryId: string): Promise<string> {
  await flushExtraction()
  const file = await getRepositoryFile(repositoryId, 'big.ts')
  expect(file?.content).toContain(TOKEN)
  const hits = await searchNotes({ vaultIds: [], repositoryIds: [repositoryId] }, TOKEN)
  expect(hits.some((h) => h.path === 'big.ts')).toBe(true)
  expect((await findSymbols([repositoryId], TOKEN)).some((s) => s.name === TOKEN)).toBe(true)
  return file!.id
}

/** Skipped: no row for read_file, no search hit, no symbol rows left behind. */
async function expectGone(repositoryId: string, oldFileId: string): Promise<void> {
  await flushExtraction()
  expect(await getRepositoryFile(repositoryId, 'big.ts')).toBeNull()
  const hits = await searchNotes({ vaultIds: [], repositoryIds: [repositoryId] }, TOKEN)
  expect(hits.filter((h) => h.path === 'big.ts')).toEqual([])
  expect((await findSymbols([repositoryId], TOKEN)).filter((s) => s.name === TOKEN)).toEqual([])
  const symbols = await db
    .select({ id: repositoryFileSymbols.id })
    .from(repositoryFileSymbols)
    .where(eq(repositoryFileSymbols.fileId, oldFileId))
  expect(symbols).toEqual([])
  // The rest of the repository is still indexed.
  expect((await getRepositoryFile(repositoryId, 'small.ts'))?.content).toBe('export const small = 1\n')
}

describe('a skipped repository file does not keep its stale index row (#923)', () => {
  async function gitRemote() {
    const bareDir = await makeTempDir('chapters-923-bare-')
    await simpleGit(bareDir).init(true)
    const workDir = await makeTempDir('chapters-923-work-')
    const git = simpleGit(workDir)
    await git.init()
    await git.addConfig('user.email', 'test@chapters.local')
    await git.addConfig('user.name', 'Test')
    await git.addRemote('origin', bareDir)
    const commit = async (message: string) => {
      await git.add('.')
      await git.commit(message)
      await git.push('origin', 'HEAD:refs/heads/main')
      await simpleGit(bareDir).raw(['symbolic-ref', 'HEAD', 'refs/heads/main'])
    }
    return { remoteUrl: `file://${bareDir}`, workDir, commit }
  }

  for (const [label, changed] of [
    ['grows past 1 MB', OVERSIZED],
    ['gains a NUL byte', WITH_NUL],
  ] as const) {
    it(`git: a file that ${label} is removed from the index`, async () => {
      const { remoteUrl, workDir, commit } = await gitRemote()
      await writeFile(join(workDir, 'big.ts'), ORIGINAL)
      await writeFile(join(workDir, 'small.ts'), 'export const small = 1\n')
      await commit('initial')
      const repo = await makeRepo({ ingestionMethod: 'git', gitUrl: remoteUrl })
      await syncGitRepository(repo.id)
      const oldId = await expectIndexed(repo.id)

      await writeFile(join(workDir, 'big.ts'), changed)
      await commit('change big.ts')
      await syncGitRepository(repo.id)
      await expectGone(repo.id, oldId)
    })

    it(`local path: a file that ${label} is removed from the index`, async () => {
      const root = await makeTempDir('chapters-923-local-')
      await writeFile(join(root, 'big.ts'), ORIGINAL)
      await writeFile(join(root, 'small.ts'), 'export const small = 1\n')
      const repo = await makeRepo({ ingestionMethod: 'local_path', localPath: root })
      await syncLocalRepository(repo.id)
      const oldId = await expectIndexed(repo.id)

      await writeFile(join(root, 'big.ts'), changed)
      await syncLocalRepository(repo.id)
      await expectGone(repo.id, oldId)
    })

    it(`agent push: a pushed file that ${label} is removed from the index`, async () => {
      const repo = await makeRepo({ ingestionMethod: 'agent_push' })
      const paths = ['big.ts', 'small.ts']
      await syncRepositoryFiles(
        repo.id,
        [
          { path: 'big.ts', content: ORIGINAL },
          { path: 'small.ts', content: 'export const small = 1\n' },
        ],
        paths,
      )
      const oldId = await expectIndexed(repo.id)

      const result = await syncRepositoryFiles(repo.id, [{ path: 'big.ts', content: changed }], paths)
      expect(result).toEqual({ created: 0, updated: 0, deleted: 1, unchanged: 0 })
      await expectGone(repo.id, oldId)
    })
  }

  it('a file that was never indexed and is pushed with a NUL byte is not created', async () => {
    const repo = await makeRepo({ ingestionMethod: 'agent_push' })
    const result = await syncRepositoryFiles(repo.id, [{ path: 'bin.dat', content: 'a\0b' }], ['bin.dat'])
    expect(result).toEqual({ created: 0, updated: 0, deleted: 0, unchanged: 0 })
    expect(await getRepositoryFile(repo.id, 'bin.dat')).toBeNull()
  })
})
