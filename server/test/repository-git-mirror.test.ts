import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as SimpleGit from 'simple-git'
import { simpleGit } from 'simple-git'
import { eq } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { db } from '../src/db/client.js'
import { repositories } from '../src/db/schema.js'
import { syncGitRepository } from '../src/repositories/git-sync.js'
import { extractionWork, flushExtraction } from '../src/repositories/extraction-queue.js'
import { getRepositoryFile, listRepositoryFiles } from '../src/repositories/store.js'
import { embedder } from '../src/search/embeddings.js'
import { createActiveUser, loginCookie } from './helpers.js'

// #684: a git sync fetches into a persistent mirror instead of cloning the
// whole repository again (#542: 71 MB every 5 minutes), and only files whose
// blob changed are read, parsed and embedded.
//
// Every git command the server runs is counted: `clone` for simple-git's
// clone(), the subcommand for raw([...]). The real git still runs.
const gitCalls = vi.hoisted(() => [] as string[])
vi.mock('simple-git', async (importOriginal) => {
  const actual = await importOriginal<typeof SimpleGit>()
  const counted = (...args: Parameters<typeof actual.simpleGit>) => {
    const git = actual.simpleGit(...args)
    return new Proxy(git, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown
        if (typeof value !== 'function' || (prop !== 'clone' && prop !== 'raw' && prop !== 'fetch')) return value
        return (...callArgs: unknown[]) => {
          const first = Array.isArray(callArgs[0]) ? (callArgs[0] as unknown[])[0] : callArgs[0]
          gitCalls.push(prop === 'raw' ? String(first) : prop)
          return (value as (...a: unknown[]) => unknown).apply(target, callArgs)
        }
      },
    })
  }
  return { ...actual, simpleGit: counted, default: counted }
})

let dirs: string[] = []
const parsed: string[] = []
let embedCalls = 0

beforeEach(() => {
  gitCalls.length = 0
  parsed.length = 0
  embedCalls = 0
  const processFile = extractionWork.processFile
  vi.spyOn(extractionWork, 'processFile').mockImplementation(async (fileId) => {
    parsed.push(fileId)
    return processFile(fileId)
  })
  const embed = embedder.embed.bind(embedder)
  vi.spyOn(embedder, 'embed').mockImplementation(async (texts) => {
    embedCalls++
    return embed(texts)
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
  dirs = []
})

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** A local file:// remote with a working copy that pushes to it; HEAD pinned to main. */
async function makeRemote(files: Record<string, string>) {
  const bareDir = await makeTempDir('elara-mirror-remote-')
  await simpleGit(bareDir).init(true)
  await simpleGit(bareDir).raw(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  const workDir = await makeTempDir('elara-mirror-work-')
  const git = simpleGit(workDir)
  await git.init()
  await git.addConfig('user.email', 'test@elara.local')
  await git.addConfig('user.name', 'Test')
  await git.raw(['checkout', '-b', 'main'])
  const commit = async (next: Record<string, string>, message: string, force = false) => {
    for (const [path, content] of Object.entries(next)) await writeFile(join(workDir, path), content)
    await git.add('.')
    await git.commit(message)
    await git.raw(['push', ...(force ? ['--force'] : []), bareDir, 'HEAD:refs/heads/main'])
  }
  await commit(files, 'initial')
  return { remoteUrl: `file://${bareDir}`, bareDir, workDir, git, commit }
}

async function makeRepo(gitUrl: string) {
  const owner = await createActiveUser()
  const [repo] = await db
    .insert(repositories)
    .values({ name: 'git-mirror', ownerId: owner.id, ingestionMethod: 'git', gitUrl })
    .returning()
  return { repo: repo!, owner }
}

/** Where the mirror lives: DATA_DIR/git-mirrors/<repositoryId>.git. */
const mirrorDir = (repositoryId: string) => join(config.dataDir, 'git-mirrors', `${repositoryId}.git`)

async function syncAndDrain(repositoryId: string): Promise<void> {
  await syncGitRepository(repositoryId)
  await flushExtraction()
}

function resetCounts(): void {
  gitCalls.length = 0
  parsed.length = 0
  embedCalls = 0
}

const ONE = 'export function one(): number {\n  return 1\n}\n'
const TWO = 'export function two(): number {\n  return 2\n}\n'
const THREE = 'export function three(): number {\n  return 3\n}\n'

describe('git sync into a persistent mirror (#684)', () => {
  it('a sync with no upstream change clones nothing and parses and embeds nothing', async () => {
    const { remoteUrl } = await makeRemote({ 'one.ts': ONE, 'two.ts': TWO })
    const { repo } = await makeRepo(remoteUrl)
    await syncAndDrain(repo.id)
    expect(parsed).toHaveLength(2)
    expect(existsSync(mirrorDir(repo.id))).toBe(true)

    resetCounts()
    await syncAndDrain(repo.id)

    expect(gitCalls).not.toContain('clone')
    expect(parsed).toEqual([])
    expect(embedCalls).toBe(0)
    const [row] = await db.select().from(repositories).where(eq(repositories.id, repo.id))
    expect(row!.syncStatus).toBe('idle')
  })

  it('an upstream one-file commit fetches into the mirror and re-processes exactly that file', async () => {
    const { remoteUrl, commit } = await makeRemote({ 'one.ts': ONE, 'two.ts': TWO, 'three.ts': THREE })
    const { repo } = await makeRepo(remoteUrl)
    await syncAndDrain(repo.id)

    await commit({ 'two.ts': TWO.replace('2', '22') }, 'edit two')
    resetCounts()
    await syncAndDrain(repo.id)

    expect(gitCalls).not.toContain('clone')
    expect(gitCalls).toContain('fetch')
    const two = await getRepositoryFile(repo.id, 'two.ts')
    expect(two!.content).toContain('return 22')
    expect(parsed).toEqual([two!.id])
    expect(embedCalls).toBeGreaterThan(0)
    expect((await listRepositoryFiles(repo.id)).map((f) => f.path).sort()).toEqual(['one.ts', 'three.ts', 'two.ts'])
  })

  it('a force-pushed rewrite indexes the new tree from the mirror and drops what it removed', async () => {
    const { remoteUrl, git, workDir, commit } = await makeRemote({ 'one.ts': ONE, 'two.ts': TWO })
    const { repo } = await makeRepo(remoteUrl)
    await syncAndDrain(repo.id)

    // A new root commit with other content: the synced commit is no ancestor of it.
    await git.raw(['checkout', '--orphan', 'rewrite'])
    await git.raw(['rm', '-rf', '--cached', '.'])
    await rm(join(workDir, 'two.ts'))
    await commit({ 'one.ts': ONE, 'three.ts': THREE }, 'rewrite', true)
    resetCounts()
    await syncAndDrain(repo.id)

    expect(gitCalls).not.toContain('clone')
    expect(gitCalls).toContain('fetch')
    expect((await listRepositoryFiles(repo.id)).map((f) => f.path).sort()).toEqual(['one.ts', 'three.ts'])
    const three = await getRepositoryFile(repo.id, 'three.ts')
    // one.ts kept its blob: only the new file is parsed.
    expect(parsed).toEqual([three!.id])
    const [row] = await db.select().from(repositories).where(eq(repositories.id, repo.id))
    expect(row!.lastSyncedCommit).toBe((await git.revparse(['HEAD'])).trim())
  })

  it('follows the remote default branch when it switches', async () => {
    const { remoteUrl, bareDir, git, workDir } = await makeRemote({ 'one.ts': ONE })
    const { repo } = await makeRepo(remoteUrl)
    await syncAndDrain(repo.id)

    await git.raw(['checkout', '-b', 'trunk'])
    await writeFile(join(workDir, 'two.ts'), TWO)
    await git.add('.')
    await git.commit('on trunk')
    await git.raw(['push', bareDir, 'HEAD:refs/heads/trunk'])
    await simpleGit(bareDir).raw(['symbolic-ref', 'HEAD', 'refs/heads/trunk'])
    resetCounts()
    await syncAndDrain(repo.id)

    expect(gitCalls).not.toContain('clone')
    const [row] = await db.select().from(repositories).where(eq(repositories.id, repo.id))
    expect(row!.defaultBranch).toBe('trunk')
    expect((await listRepositoryFiles(repo.id)).map((f) => f.path).sort()).toEqual(['one.ts', 'two.ts'])
  })

  it('keeps the mirror bounded: superseded objects and shallow roots are pruned', async () => {
    const { remoteUrl, commit } = await makeRemote({ 'one.ts': ONE })
    const { repo } = await makeRepo(remoteUrl)
    await syncAndDrain(repo.id)
    for (let i = 0; i < 8; i++) {
      await commit({ 'one.ts': `${ONE}// edit ${i}\n` }, `edit ${i}`)
      await syncAndDrain(repo.id)
    }
    const packs = (await readdir(join(mirrorDir(repo.id), 'objects', 'pack'))).filter((f) => f.endsWith('.pack'))
    expect(packs.length).toBeLessThanOrEqual(5)
    const shallow = join(mirrorDir(repo.id), 'shallow')
    const roots = existsSync(shallow) ? (await readFile(shallow, 'utf8')).trim().split('\n') : []
    expect(roots.length).toBeLessThanOrEqual(5)
  })

  it('deleting the repository removes its mirror', async () => {
    const { remoteUrl } = await makeRemote({ 'one.ts': ONE })
    const { repo, owner } = await makeRepo(remoteUrl)
    await syncAndDrain(repo.id)
    expect(existsSync(mirrorDir(repo.id))).toBe(true)

    const app = await buildApp()
    await app.ready()
    try {
      const cookie = await loginCookie(app, owner.email)
      const res = await app.inject({ method: 'DELETE', url: `/api/repositories/${repo.id}`, headers: { cookie } })
      expect(res.statusCode).toBe(200)
    } finally {
      await app.close()
    }
    // Removed in the background, after any sync still using it.
    await vi.waitFor(() => expect(existsSync(mirrorDir(repo.id))).toBe(false), { timeout: 5_000, interval: 20 })
  })
})
