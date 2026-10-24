import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { simpleGit } from 'simple-git'
import { eq } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { repositories, repositoryFileImports } from '../src/db/schema.js'
import { syncGitRepository } from '../src/repositories/git-sync.js'
import { syncLocalRepository } from '../src/repositories/scheduler.js'
import { getRepositoryFile } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { findSymbols, searchNotes } from '../src/search/search.js'
import { createActiveUser, loginCookie, symbolBlocks } from './helpers.js'

// #923: a file that grows past the 1 MB cap or gains a NUL byte used to keep
// its old row, because the git and local-path scans skipped it but still
// listed its path as current. read_file, search, symbols and imports then
// served the old version forever. A skipped file now leaves the index, and
// comes back once it is indexable again.

const TOKEN = 'staleQuasarBeacon'
const ORIGINAL = `import { small } from './small'\nexport function ${TOKEN}() { return small }\n`
const OVERSIZED = `${ORIGINAL}// ${'x'.repeat(1_100_000)}\n`
const WITH_NUL = `${ORIGINAL}const tail = 'a\0b'\n`
const SMALL = 'export const small = 1\n'

let app: FastifyInstance
let ownerId: string
let mcp: Client

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const owner = await createActiveUser()
  ownerId = owner.id
  const cookie = await loginCookie(app, owner.email)
  const { token } = (
    await app.inject({
      method: 'POST',
      url: '/api/mcp-connections',
      headers: { cookie },
      body: { name: 'skipped-file-agent', scope: 'account' },
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

async function makeRepo(values: { ingestionMethod: 'git' | 'local_path'; gitUrl?: string; localPath?: string }) {
  const [repo] = await db
    .insert(repositories)
    .values({ name: 'skipped-file-test', ownerId, ...values })
    .returning()
  return repo!
}

async function readFileTool(repositoryId: string): Promise<{ isError: boolean; text: string }> {
  const result = await mcp.callTool({ name: 'read_file', arguments: { repositoryId, path: 'big.ts' } })
  const content = result.content as Array<{ type: string; text?: string }>
  return { isError: result.isError === true, text: content[0]?.text ?? '' }
}

async function importsOf(fileId: string) {
  return db
    .select({ targetPath: repositoryFileImports.targetPath })
    .from(repositoryFileImports)
    .where(eq(repositoryFileImports.sourceFileId, fileId))
}

async function symbolsOf(fileId: string) {
  return (await symbolBlocks(fileId)).map(({ name }) => ({ name }))
}

/** Indexed: read_file, a search hit, the symbol and the import are all there. */
async function expectIndexed(repositoryId: string): Promise<string> {
  await flushExtraction()
  const file = await getRepositoryFile(repositoryId, 'big.ts')
  expect(file?.content).toBe(ORIGINAL)
  const read = await readFileTool(repositoryId)
  expect(read.isError).toBe(false)
  expect(read.text).toContain(TOKEN)
  const hits = await searchNotes({ vaultIds: [], repositoryIds: [repositoryId] }, TOKEN)
  expect(hits.results.some((h) => h.path === 'big.ts')).toBe(true)
  expect((await findSymbols([repositoryId], TOKEN)).results.some((s) => s.name === TOKEN)).toBe(true)
  expect((await symbolsOf(file!.id)).map((s) => s.name)).toContain(TOKEN)
  expect((await importsOf(file!.id)).map((i) => i.targetPath)).toEqual(['./small'])
  return file!.id
}

/** Skipped: read_file is NOT_FOUND, no search hit, no symbol or import rows left behind. */
async function expectGone(repositoryId: string, oldFileId: string): Promise<void> {
  await flushExtraction()
  expect(await getRepositoryFile(repositoryId, 'big.ts')).toBeNull()
  const read = await readFileTool(repositoryId)
  expect(read.isError).toBe(true)
  expect(read.text).toMatch(/^\{"error":\{"code":"NOT_FOUND","message":"file not found"/)
  const hits = await searchNotes({ vaultIds: [], repositoryIds: [repositoryId] }, TOKEN)
  expect(hits.results.filter((h) => h.path === 'big.ts')).toEqual([])
  expect((await findSymbols([repositoryId], TOKEN)).results.filter((s) => s.name === TOKEN)).toEqual([])
  expect(await symbolsOf(oldFileId)).toEqual([])
  expect(await importsOf(oldFileId)).toEqual([])
  // The rest of the repository is still indexed.
  expect((await getRepositoryFile(repositoryId, 'small.ts'))?.content).toBe(SMALL)
}

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

describe('a skipped repository file does not keep its stale index row (#923)', () => {
  for (const [label, changed] of [
    ['grows past 1 MB', OVERSIZED],
    ['gains a NUL byte', WITH_NUL],
  ] as const) {
    it(`git: a file that ${label} leaves the index, and comes back once indexable`, async () => {
      const { remoteUrl, workDir, commit } = await gitRemote()
      await writeFile(join(workDir, 'big.ts'), ORIGINAL)
      await writeFile(join(workDir, 'small.ts'), SMALL)
      await commit('initial')
      const repo = await makeRepo({ ingestionMethod: 'git', gitUrl: remoteUrl })
      await syncGitRepository(repo.id)
      const oldId = await expectIndexed(repo.id)

      await writeFile(join(workDir, 'big.ts'), changed)
      await commit('change big.ts')
      await syncGitRepository(repo.id)
      await expectGone(repo.id, oldId)

      await writeFile(join(workDir, 'big.ts'), ORIGINAL)
      await commit('restore big.ts')
      await syncGitRepository(repo.id)
      await expectIndexed(repo.id)
    })

    it(`local path: a file that ${label} leaves the index, and comes back once indexable`, async () => {
      const root = await makeTempDir('chapters-923-local-')
      await writeFile(join(root, 'big.ts'), ORIGINAL)
      await writeFile(join(root, 'small.ts'), SMALL)
      const repo = await makeRepo({ ingestionMethod: 'local_path', localPath: root })
      await syncLocalRepository(repo.id)
      const oldId = await expectIndexed(repo.id)

      await writeFile(join(root, 'big.ts'), changed)
      await syncLocalRepository(repo.id)
      await expectGone(repo.id, oldId)

      await writeFile(join(root, 'big.ts'), ORIGINAL)
      await syncLocalRepository(repo.id)
      await expectIndexed(repo.id)
    })
  }
})
