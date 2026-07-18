import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { repositories } from '../src/db/schema.js'
import { syncGitRepository } from '../src/repositories/git-sync.js'
import { getRepositoryFile, listRepositoryFiles } from '../src/repositories/store.js'
import { createActiveUser } from './helpers.js'

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

/** A local file:// remote — real git plumbing, fully offline. */
async function makeBareRemote(): Promise<{ remoteUrl: string; workDir: string; git: ReturnType<typeof simpleGit> }> {
  const bareDir = await makeTempDir('chapters-bare-')
  await simpleGit(bareDir).init(true)

  const workDir = await makeTempDir('chapters-work-')
  const git = simpleGit(workDir)
  await git.init()
  await git.addConfig('user.email', 'test@chapters.local')
  await git.addConfig('user.name', 'Test')
  await git.addRemote('origin', bareDir)

  return { remoteUrl: `file://${bareDir}`, workDir, git }
}

async function makeRepo(gitUrl: string) {
  const owner = await createActiveUser()
  const [repo] = await db
    .insert(repositories)
    .values({ name: 'git-test', ownerId: owner.id, ingestionMethod: 'git', gitUrl })
    .returning()
  return repo!
}

describe('git URL ingestion', () => {
  it('clones, indexes, then propagates modification/addition/deletion on resync', async () => {
    const { remoteUrl, workDir, git } = await makeBareRemote()
    await writeFile(join(workDir, 'a.ts'), 'export const a = 1')
    await writeFile(join(workDir, 'b.ts'), 'export const b = 2')
    await git.add('.')
    await git.commit('initial')
    await git.push('origin', 'HEAD:refs/heads/main')

    const repo = await makeRepo(remoteUrl)
    await syncGitRepository(repo.id)

    let files = await listRepositoryFiles(repo.id)
    expect(files.map((f) => f.path).sort()).toEqual(['a.ts', 'b.ts'])

    // Modify a.ts, add c.ts, delete b.ts — then push and resync.
    await writeFile(join(workDir, 'a.ts'), 'export const a = 999')
    await writeFile(join(workDir, 'c.ts'), 'export const c = 3')
    await unlink(join(workDir, 'b.ts'))
    await git.add('.')
    await git.commit('changes')
    await git.push('origin', 'HEAD:refs/heads/main')

    await syncGitRepository(repo.id)

    files = await listRepositoryFiles(repo.id)
    expect(files.map((f) => f.path).sort()).toEqual(['a.ts', 'c.ts'])
    const a = await getRepositoryFile(repo.id, 'a.ts')
    expect(a?.content).toContain('999')
  }, 30000)

  it('records a sync error without throwing the caller into an unhandled state', async () => {
    const repo = await makeRepo('file:///nonexistent/path/to/nowhere.git')
    await expect(syncGitRepository(repo.id)).rejects.toThrow()
    const updated = (
      await db.select().from(repositories).where(eq(repositories.id, repo.id))
    )[0]
    expect(updated?.syncStatus).toBe('error')
    expect(updated?.lastSyncError).toBeTruthy()
  }, 15000)
})
