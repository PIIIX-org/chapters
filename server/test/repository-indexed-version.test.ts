import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { simpleGit } from 'simple-git'
import { eq } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { jobs, repositories, repositoryFiles } from '../src/db/schema.js'
import { syncGitRepository } from '../src/repositories/git-sync.js'
import { syncLocalRepository } from '../src/repositories/scheduler.js'
import { extractionJobKey, flushExtraction, scheduleMissingExtractions } from '../src/repositories/extraction-queue.js'
import { listRepositoryFiles } from '../src/repositories/store.js'
import { createActiveUser, loginCookie } from './helpers.js'

// #471, owner decision D11 (#930, ADR-004 §2.9): every repository records
// the version it was indexed at, the git commit when one is known and a tree
// hash of the indexed files otherwise, and repository answers name it once.

/** The tree of no files: sha256 of nothing, cut to 16 hex. */
const EMPTY_TREE = 'e3b0c44298fc1c14'

let app: FastifyInstance
let ownerId: string
let cookie: string
let mcp: Client

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const owner = await createActiveUser()
  ownerId = owner.id
  cookie = await loginCookie(app, owner.email)
  const { token } = (
    await app.inject({
      method: 'POST',
      url: '/api/mcp-connections',
      headers: { cookie },
      body: { name: 'indexed-version-agent', scope: 'account' },
    })
  ).json() as { token: string }
  mcp = new Client({ name: 'test-client', version: '0.0.0' })
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  )
})

afterAll(async () => {
  await mcp.close().catch(() => {})
  await app.close()
})

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

async function put(root: string, path: string, content: string): Promise<void> {
  await mkdir(join(root, path, '..'), { recursive: true })
  await writeFile(join(root, path), content)
}

/** A work tree with one commit of `files`. */
async function gitWorkTree(prefix: string, files: Record<string, string>) {
  const dir = await makeTempDir(prefix)
  const git = simpleGit(dir)
  await git.init()
  await git.addConfig('user.email', 'test@elara.local')
  await git.addConfig('user.name', 'Test')
  for (const [path, content] of Object.entries(files)) await put(dir, path, content)
  await git.add('.')
  await git.commit('initial')
  return { dir, git, head: async () => (await git.revparse(['HEAD'])).trim() }
}

async function makeRepo(values: { ingestionMethod: 'git' | 'local_path'; gitUrl?: string; localPath?: string }) {
  const [repo] = await db
    .insert(repositories)
    .values({ name: 'indexed-version-test', ownerId, ...values })
    .returning()
  return repo!
}

async function row(repositoryId: string) {
  return (await db.select().from(repositories).where(eq(repositories.id, repositoryId)))[0]!
}

async function callText(name: string, args: Record<string, unknown>): Promise<string> {
  const res = await mcp.callTool({ name, arguments: args })
  const content = res.content as Array<{ type: string; text?: string }>
  expect(res.isError, content[0]?.text).not.toBe(true)
  return content[0]?.text ?? ''
}

async function status(repositoryId: string): Promise<{ commit?: string; tree?: string }> {
  return JSON.parse(await callText('repository_status', { repositoryId })) as { commit?: string; tree?: string }
}

describe('git sync records the commit it indexed', () => {
  it("stores HEAD's SHA and moves it on a new commit", async () => {
    const bare = await makeTempDir('indexed-bare-')
    await simpleGit(bare).init(true)
    const work = await gitWorkTree('indexed-git-work-', { 'a.ts': 'export const a = 1\n' })
    await work.git.addRemote('origin', bare)
    await work.git.push('origin', 'HEAD:refs/heads/main')
    await simpleGit(bare).raw(['symbolic-ref', 'HEAD', 'refs/heads/main'])

    const repo = await makeRepo({ ingestionMethod: 'git', gitUrl: `file://${bare}` })
    await syncGitRepository(repo.id)
    const first = await work.head()
    expect((await row(repo.id)).lastSyncedCommit).toBe(first)
    expect(await status(repo.id)).toMatchObject({ commit: first })
    expect((await status(repo.id)).tree).toBeUndefined()

    await put(work.dir, 'a.ts', 'export const a = 2\n')
    await work.git.add('.')
    await work.git.commit('second')
    await work.git.push('origin', 'HEAD:refs/heads/main')
    await syncGitRepository(repo.id)
    const second = await work.head()
    expect(second).not.toBe(first)
    expect((await row(repo.id)).lastSyncedCommit).toBe(second)
    expect(await status(repo.id)).toMatchObject({ commit: second })
  })
})

describe('local-path sync records the commit of a clean git work tree', () => {
  it('a folder that is a clean git work tree records HEAD', async () => {
    const work = await gitWorkTree('indexed-local-git-', { 'a.ts': 'export const a = 1\n' })
    const repo = await makeRepo({ ingestionMethod: 'local_path', localPath: work.dir })
    await syncLocalRepository(repo.id)
    const head = await work.head()
    expect((await row(repo.id)).lastSyncedCommit).toBe(head)
    expect((await row(repo.id)).treeHash).toMatch(/^[0-9a-f]{16}$/)
    expect(await status(repo.id)).toMatchObject({ commit: head })
  })

  it('uncommitted changes are not that commit: null, and the answer names the tree', async () => {
    const work = await gitWorkTree('indexed-local-dirty-', { 'a.ts': 'export const a = 1\n' })
    const repo = await makeRepo({ ingestionMethod: 'local_path', localPath: work.dir })
    await syncLocalRepository(repo.id)
    const clean = await row(repo.id)
    expect(clean.lastSyncedCommit).toBe(await work.head())

    await put(work.dir, 'a.ts', 'export const a = 2\n')
    await syncLocalRepository(repo.id)
    const dirty = await row(repo.id)
    expect(dirty.lastSyncedCommit).toBeNull()
    expect(dirty.treeHash).toMatch(/^[0-9a-f]{16}$/)
    expect(dirty.treeHash).not.toBe(clean.treeHash)
    const answer = await status(repo.id)
    expect(answer.commit).toBeUndefined()
    expect(answer.tree).toBe(dirty.treeHash)
  })

  it('a folder outside any git repository records no commit, only the tree', async () => {
    const dir = await makeTempDir('indexed-local-plain-')
    await put(dir, 'a.ts', 'export const a = 1\n')
    const repo = await makeRepo({ ingestionMethod: 'local_path', localPath: dir })
    await syncLocalRepository(repo.id)
    const synced = await row(repo.id)
    expect(synced.lastSyncedCommit).toBeNull()
    expect(synced.treeHash).toMatch(/^[0-9a-f]{16}$/)
    expect(await status(repo.id)).toEqual(expect.objectContaining({ tree: synced.treeHash }))
    expect((await status(repo.id)).commit).toBeUndefined()
  })

  // git status hides untracked files that git's own ignore rules match, but
  // the folder's scan reads only the folder's .gitignore files and its own
  // .git/info/exclude: such a file is indexed although HEAD does not hold it.
  async function syncIgnoredUntracked(work: { dir: string }, folder: string): Promise<string | null> {
    await put(work.dir, `${folder}x.gen.ts`, 'export const generated = 1\n')
    const repo = await makeRepo({ ingestionMethod: 'local_path', localPath: join(work.dir, folder) })
    await syncLocalRepository(repo.id)
    expect((await listRepositoryFiles(repo.id)).map((f) => f.path).sort()).toEqual(['a.ts', 'x.gen.ts'])
    return (await row(repo.id)).lastSyncedCommit
  }

  it('a subfolder indexes a file its parent .gitignore ignores: null', async () => {
    const work = await gitWorkTree('indexed-local-parent-ignore-', { '.gitignore': '*.gen.ts\n', 'sub/a.ts': 'export const a = 1\n' })
    expect(await syncIgnoredUntracked(work, 'sub/')).toBeNull()
  })

  it("a subfolder indexes a file the repository's .git/info/exclude ignores: null", async () => {
    const work = await gitWorkTree('indexed-local-info-exclude-', { 'sub/a.ts': 'export const a = 1\n' })
    await put(work.dir, '.git/info/exclude', '*.gen.ts\n')
    expect(await syncIgnoredUntracked(work, 'sub/')).toBeNull()
  })

  it('a folder indexes a file core.excludesFile ignores: null', async () => {
    const work = await gitWorkTree('indexed-local-excludes-file-', { 'a.ts': 'export const a = 1\n' })
    const excludes = join(await makeTempDir('indexed-excludes-'), 'ignore')
    await writeFile(excludes, '*.gen.ts\n')
    await work.git.addConfig('core.excludesFile', excludes)
    expect(await syncIgnoredUntracked(work, '')).toBeNull()
  })

  it('a clean subfolder of a git work tree records HEAD', async () => {
    const work = await gitWorkTree('indexed-local-sub-', { 'sub/a.ts': 'export const a = 1\n', 'other.ts': 'export const o = 1\n' })
    const repo = await makeRepo({ ingestionMethod: 'local_path', localPath: join(work.dir, 'sub') })
    await syncLocalRepository(repo.id)
    expect((await row(repo.id)).lastSyncedCommit).toBe(await work.head())
  })
})

describe('agent push takes an optional commit', () => {
  async function pushRepo() {
    const repo = (
      await app.inject({
        method: 'POST',
        url: '/api/repositories',
        headers: { cookie },
        body: { name: 'indexed-push', ingestionMethod: 'agent_push' },
      })
    ).json() as { id: string }
    const { token } = (
      await app.inject({ method: 'POST', url: `/api/repositories/${repo.id}/sync-tokens`, headers: { cookie } })
    ).json() as { token: string }
    const push = (body: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/repositories/sync', headers: { authorization: `Bearer ${token}` }, body })
    return { repoId: repo.id, push }
  }

  const COMMIT = '0123456789abcdef0123456789abcdef01234567'
  const files = [{ path: 'src/thrust.ts', content: 'export function orbitalThrust() { return 1 }\n' }]

  it('records the commit sent with the files', async () => {
    const { repoId, push } = await pushRepo()
    const res = await push({ files, currentPaths: ['src/thrust.ts'], commit: COMMIT })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ created: 1, updated: 0, deleted: 0, unchanged: 0 })
    expect((await row(repoId)).lastSyncedCommit).toBe(COMMIT)
    expect(await status(repoId)).toMatchObject({ commit: COMMIT })
  })

  it('a push without a commit clears it: the tree names the snapshot', async () => {
    const { repoId, push } = await pushRepo()
    await push({ files, currentPaths: ['src/thrust.ts'], commit: COMMIT })
    const res = await push({ files: [], currentPaths: ['src/thrust.ts'] })
    expect(res.statusCode).toBe(200)
    const synced = await row(repoId)
    expect(synced.lastSyncedCommit).toBeNull()
    expect(synced.treeHash).toMatch(/^[0-9a-f]{16}$/)
    expect(await status(repoId)).toMatchObject({ tree: synced.treeHash })
  })

  it('a commit that is not a hex object name is refused', async () => {
    const { push } = await pushRepo()
    const res = await push({ files, currentPaths: ['src/thrust.ts'], commit: 'main; rm -rf /' })
    expect(res.statusCode).toBe(400)
  })

  it('read_file, browse_repository, search and find_symbols name the commit once per answer', async () => {
    const { repoId, push } = await pushRepo()
    await push({ files, currentPaths: ['src/thrust.ts'], commit: COMMIT })
    await flushExtraction()

    const answers = {
      read_file: await callText('read_file', { repositoryId: repoId, path: 'src/thrust.ts' }),
      browse_repository: await callText('browse_repository', { repositoryId: repoId }),
      search: await callText('search', { repositoryId: repoId, query: 'orbitalThrust' }),
      find_symbols: await callText('find_symbols', { repositoryId: repoId, query: 'orbitalThrust' }),
      repository_status: await callText('repository_status', { repositoryId: repoId }),
    }
    for (const [name, text] of Object.entries(answers)) {
      expect(text.split(COMMIT).length - 1, `${name}: ${text}`).toBe(1)
      expect(text, name).not.toContain('"tree"')
    }
  })

  it('read_file says when the outline lags its content: index pending, then failed', async () => {
    const { repoId, push } = await pushRepo()
    await push({ files, currentPaths: ['src/thrust.ts'], commit: COMMIT })
    await flushExtraction()
    const read = async () =>
      JSON.parse(await callText('read_file', { repositoryId: repoId, path: 'src/thrust.ts' })) as {
        commit?: string
        index?: string
        content: string
        symbols: Array<{ name: string }>
      }
    const current = await read()
    expect(current.index).toBeUndefined()
    expect(current.symbols.map((s) => s.name)).toEqual(['orbitalThrust'])

    // The stored content moved on and its extraction has not run yet.
    const content = 'export function warpDrive() { return 2 }\n'
    const contentHash = createHash('sha256').update(content).digest('hex')
    await db.update(repositoryFiles).set({ content, contentHash }).where(eq(repositoryFiles.repositoryId, repoId))
    const pending = await read()
    expect(pending).toMatchObject({ commit: COMMIT, index: 'pending', content })
    expect(pending.symbols.map((s) => s.name)).toEqual(['orbitalThrust'])

    await scheduleMissingExtractions()
    await flushExtraction()
    const caughtUp = await read()
    expect(caughtUp.index).toBeUndefined()
    expect(caughtUp.symbols.map((s) => s.name)).toEqual(['warpDrive'])

    const [file] = await db.select({ id: repositoryFiles.id }).from(repositoryFiles).where(eq(repositoryFiles.repositoryId, repoId))
    await db.update(jobs).set({ lastError: 'boom' }).where(eq(jobs.idempotencyKey, extractionJobKey(file!.id, contentHash)))
    expect((await read()).index).toBe('failed')
  })

  it('search and find_symbols over several repositories carry neither commit nor tree', async () => {
    const first = await pushRepo()
    const second = await pushRepo()
    await first.push({ files, currentPaths: ['src/thrust.ts'], commit: COMMIT })
    await second.push({ files, currentPaths: ['src/thrust.ts'] })
    await flushExtraction()
    for (const [name, args] of [
      ['search', { query: 'orbitalThrust', everywhere: true }],
      ['find_symbols', { query: 'orbitalThrust' }],
    ] as const) {
      const answer = JSON.parse(await callText(name, args)) as Record<string, unknown>
      expect((answer.results as unknown[]).length, name).toBeGreaterThan(1)
      expect('commit' in answer || 'tree' in answer, name).toBe(false)
    }
  })

  it('an empty repository after a sync names the empty tree', async () => {
    const { repoId, push } = await pushRepo()
    expect(await status(repoId)).not.toHaveProperty('tree')
    await push({ files: [], currentPaths: [] })
    expect(await status(repoId)).toMatchObject({ tree: EMPTY_TREE })
  })
})
