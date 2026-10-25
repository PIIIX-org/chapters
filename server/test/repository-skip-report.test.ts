import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { simpleGit } from 'simple-git'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { repositories } from '../src/db/schema.js'
import { syncGitRepository } from '../src/repositories/git-sync.js'
import { syncLocalRepository } from '../src/repositories/scheduler.js'
import { listRepositoryFiles } from '../src/repositories/store.js'
import { createActiveUser, loginCookie } from './helpers.js'

// #465 (owner decision D12, #930): a git clone holds only tracked files, so
// everything in it is source, a committed build/ included; a local folder
// follows its .gitignore files; and every file a sync leaves out is reported
// with the reason, in repository_status and on the REST repository row.

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
      body: { name: 'skip-report-agent', scope: 'account' },
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

async function put(root: string, path: string, content: string | Buffer): Promise<void> {
  await mkdir(join(root, path, '..'), { recursive: true })
  await writeFile(join(root, path), content)
}

async function makeRepo(values: { ingestionMethod: 'git' | 'local_path'; gitUrl?: string; localPath?: string }) {
  const [repo] = await db
    .insert(repositories)
    .values({ name: 'skip-report-test', ownerId, ...values })
    .returning()
  return repo!
}

async function indexedPaths(repositoryId: string): Promise<string[]> {
  return (await listRepositoryFiles(repositoryId)).map((f) => f.path).sort()
}

interface Skipped {
  too_large: number
  binary: number
  ignored: number
  over_file_cap: number
  sample: Array<{ path: string; reason: string }>
}

async function repositoryStatus(repositoryId: string): Promise<{ syncStatus: string; skipped?: Skipped }> {
  const res = await mcp.callTool({ name: 'repository_status', arguments: { repositoryId } })
  expect(res.isError).not.toBe(true)
  const content = res.content as Array<{ type: string; text?: string }>
  return JSON.parse(content[0]?.text ?? '{}') as { syncStatus: string; skipped?: Skipped }
}

async function restRow(repositoryId: string): Promise<{ skipped?: Skipped }> {
  const res = await app.inject({ method: 'GET', url: '/api/repositories', headers: { cookie } })
  const rows = res.json() as Array<{ id: string; skipped?: Skipped }>
  return rows.find((r) => r.id === repositoryId)!
}

describe('git sync indexes every tracked file (#465)', () => {
  it('a committed build/ (and node_modules/) is indexed', async () => {
    const bareDir = await makeTempDir('skip-report-bare-')
    await simpleGit(bareDir).init(true)
    const workDir = await makeTempDir('skip-report-work-')
    const git = simpleGit(workDir)
    await git.init()
    await git.addConfig('user.email', 'test@elara.local')
    await git.addConfig('user.name', 'Test')
    await git.addRemote('origin', bareDir)
    await put(workDir, 'index.ts', 'export const a = 1\n')
    await put(workDir, 'build/src.ts', 'export function buildStep() { return 1 }\n')
    await put(workDir, 'dist/keep.ts', 'export const kept = true\n')
    await put(workDir, 'vendor/node_modules/lib.js', 'module.exports = 1\n')
    await put(workDir, 'logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await git.add('.')
    await git.commit('initial')
    await git.push('origin', 'HEAD:refs/heads/main')
    await simpleGit(bareDir).raw(['symbolic-ref', 'HEAD', 'refs/heads/main'])

    const repo = await makeRepo({ ingestionMethod: 'git', gitUrl: `file://${bareDir}` })
    await syncGitRepository(repo.id)

    expect(await indexedPaths(repo.id)).toEqual(['build/src.ts', 'dist/keep.ts', 'index.ts', 'vendor/node_modules/lib.js'])
    const status = await repositoryStatus(repo.id)
    expect(status.skipped).toEqual({
      too_large: 0,
      binary: 1,
      ignored: 0,
      over_file_cap: 0,
      sample: [{ path: 'logo.png', reason: 'binary' }],
    })
  })
})

describe('local-path sync follows .gitignore and reports skips (#465)', () => {
  it('skips what .gitignore files list, nested ones included, and reports every reason', async () => {
    const root = await makeTempDir('skip-report-local-')
    await put(root, '.gitignore', 'dist/\n*.log\n')
    await put(root, 'src/app.ts', 'export const app = 1\n')
    await put(root, 'build/tool.ts', 'export const tool = 1\n')
    await put(root, 'dist/out.js', 'compiled()\n')
    await put(root, 'debug.log', 'noise\n')
    await put(root, 'pkg/.gitignore', 'generated/\n!keep.log\n')
    await put(root, 'pkg/generated/x.ts', 'export const g = 1\n')
    await put(root, 'pkg/keep.log', 'kept by negation\n')
    await put(root, 'pkg/real.ts', 'export const real = 1\n')
    await put(root, 'big.ts', `// ${'x'.repeat(1_100_000)}\n`)
    await put(root, 'blob.ts', 'a\0b\n')
    await put(root, 'photo.jpg', Buffer.from([0xff, 0xd8]))

    const repo = await makeRepo({ ingestionMethod: 'local_path', localPath: root })
    await syncLocalRepository(repo.id)

    expect(await indexedPaths(repo.id)).toEqual([
      '.gitignore',
      'build/tool.ts',
      'pkg/.gitignore',
      'pkg/keep.log',
      'pkg/real.ts',
      'src/app.ts',
    ])

    const expected = {
      too_large: 1,
      binary: 2,
      ignored: 3,
      over_file_cap: 0,
    }
    const status = await repositoryStatus(repo.id)
    expect(status.skipped).toMatchObject(expected)
    const sample = [...status.skipped!.sample].sort((a, b) => a.path.localeCompare(b.path))
    expect(sample).toEqual([
      { path: 'big.ts', reason: 'too_large' },
      { path: 'blob.ts', reason: 'binary' },
      { path: 'debug.log', reason: 'ignored' },
      { path: 'dist/', reason: 'ignored' },
      { path: 'photo.jpg', reason: 'binary' },
      { path: 'pkg/generated/', reason: 'ignored' },
    ])

    // The REST repository row carries the same report.
    expect((await restRow(repo.id)).skipped).toEqual(status.skipped)
  })

  it('without a .gitignore, node_modules is still skipped (and reported)', async () => {
    const root = await makeTempDir('skip-report-local-')
    await put(root, 'a.ts', 'export const a = 1\n')
    await put(root, 'node_modules/dep/index.js', 'module.exports = 1\n')

    const repo = await makeRepo({ ingestionMethod: 'local_path', localPath: root })
    await syncLocalRepository(repo.id)

    expect(await indexedPaths(repo.id)).toEqual(['a.ts'])
    expect((await repositoryStatus(repo.id)).skipped).toEqual({
      too_large: 0,
      binary: 0,
      ignored: 1,
      over_file_cap: 0,
      sample: [{ path: 'node_modules/', reason: 'ignored' }],
    })
  })

  it('a clean sync reports no skipped key, on MCP and REST', async () => {
    const root = await makeTempDir('skip-report-local-')
    await put(root, 'a.ts', 'export const a = 1\n')
    const repo = await makeRepo({ ingestionMethod: 'local_path', localPath: root })
    await syncLocalRepository(repo.id)
    expect(await indexedPaths(repo.id)).toEqual(['a.ts'])
    expect('skipped' in (await repositoryStatus(repo.id))).toBe(false)
    expect('skipped' in (await restRow(repo.id))).toBe(false)
  })
})

describe('agent push is unchanged (#465)', () => {
  it('stores every pushed path, build/, dist/ and node_modules/ included, and reports nothing skipped', async () => {
    const repo = (
      await app.inject({
        method: 'POST',
        url: '/api/repositories',
        headers: { cookie },
        body: { name: 'skip-report-push', ingestionMethod: 'agent_push' },
      })
    ).json() as { id: string }
    const { token } = (
      await app.inject({ method: 'POST', url: `/api/repositories/${repo.id}/sync-tokens`, headers: { cookie } })
    ).json() as { token: string }
    const paths = ['build/a.ts', 'dist/b.js', 'node_modules/c.js', 'd.log']
    const res = await app.inject({
      method: 'POST',
      url: '/repositories/sync',
      headers: { authorization: `Bearer ${token}` },
      body: { files: paths.map((path) => ({ path, content: `// ${path}\n` })), currentPaths: paths },
    })
    expect(res.statusCode).toBe(200)
    expect(await indexedPaths(repo.id)).toEqual([...paths].sort())
    expect('skipped' in (await repositoryStatus(repo.id))).toBe(false)
  })
})
