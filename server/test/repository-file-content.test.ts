import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { simpleGit } from 'simple-git'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { repositories, repositoryShares } from '../src/db/schema.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { syncGitRepository } from '../src/repositories/git-sync.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
beforeAll(async () => {
  // Nothing is registered here on purpose: every request below goes through
  // the app production boots, so an unwired route in app.ts fails the suite
  // instead of passing against a plugin only the test mounts.
  app = await buildApp()
  await app.ready()
})
afterAll(async () => app.close())

const CODE = 'export function buildApp() {\n  return 1\n}\n'
const PROSE = '# readme\n'

/** Two files that differ in language, symbols, size and content. */
async function seedRepository(ownerId: string) {
  const [repo] = await db
    .insert(repositories)
    .values({ name: 'viewer-test', ownerId, ingestionMethod: 'agent_push' })
    .returning()
  await syncRepositoryFiles(
    repo!.id,
    [
      { path: 'src/build.ts', content: CODE },
      { path: 'README.md', content: PROSE },
    ],
    ['src/build.ts', 'README.md'],
  )
  await flushExtraction()
  return repo!
}

function contentUrl(id: string, path: string): string {
  return `/api/repositories/${id}/files/content?path=${encodeURIComponent(path)}`
}

describe('GET /repositories/:id/files/content', () => {
  it('serves the requested file, its language and its symbols — not a sibling', async () => {
    const owner = await createActiveUser()
    const cookie = await loginCookie(app, owner.email)
    const repo = await seedRepository(owner.id)

    const res = await app.inject({ method: 'GET', url: contentUrl(repo.id, 'src/build.ts'), headers: { cookie } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.path).toBe('src/build.ts')
    expect(body.content).toBe(CODE)
    expect(body.language).toBe('typescript')
    expect(body.size).toBe(Buffer.byteLength(CODE, 'utf8'))
    expect(body.contentHash).toBe(createHash('sha256').update(CODE).digest('hex'))
    expect(body.symbols).toEqual([
      { name: 'buildApp', kind: 'function', startLine: 1, endLine: 3 },
    ])
    expect(body.updatedAt).toBeTruthy()
    expect(body).not.toHaveProperty('embedding')

    // The other file in the same repository differs on every axis above.
    const other = await app.inject({ method: 'GET', url: contentUrl(repo.id, 'README.md'), headers: { cookie } })
    expect(other.statusCode).toBe(200)
    expect(other.json().content).toBe(PROSE)
    expect(other.json().language).toBeNull()
    expect(other.json().symbols).toEqual([])
  })

  it('lets a viewer read, and answers a stranger exactly as it answers a missing file', async () => {
    const owner = await createActiveUser()
    const viewer = await createActiveUser()
    const stranger = await createActiveUser()
    const repo = await seedRepository(owner.id)
    await db
      .insert(repositoryShares)
      .values({ repositoryId: repo.id, granteeType: 'user', granteeId: viewer.id })

    const viewerRes = await app.inject({
      method: 'GET',
      url: contentUrl(repo.id, 'src/build.ts'),
      headers: { cookie: await loginCookie(app, viewer.email) },
    })
    expect(viewerRes.statusCode).toBe(200)
    expect(viewerRes.json().content).toBe(CODE)

    const strangerRes = await app.inject({
      method: 'GET',
      url: contentUrl(repo.id, 'src/build.ts'),
      headers: { cookie: await loginCookie(app, stranger.email) },
    })
    const missingRes = await app.inject({
      method: 'GET',
      url: contentUrl(repo.id, 'src/nope.ts'),
      headers: { cookie: await loginCookie(app, owner.email) },
    })
    expect(strangerRes.statusCode).toBe(404)
    expect(missingRes.statusCode).toBe(404)
    // Indistinguishable on purpose: otherwise a stranger can probe repo ids.
    expect(strangerRes.body).toBe(missingRes.body)
    expect(strangerRes.body).not.toContain(CODE)
  })

  it('rejects a missing or empty path with 400, not with a repository lookup', async () => {
    const owner = await createActiveUser()
    const cookie = await loginCookie(app, owner.email)
    const repo = await seedRepository(owner.id)

    const missing = await app.inject({
      method: 'GET',
      url: `/api/repositories/${repo.id}/files/content`,
      headers: { cookie },
    })
    expect(missing.statusCode).toBe(400)

    const empty = await app.inject({ method: 'GET', url: contentUrl(repo.id, ''), headers: { cookie } })
    expect(empty.statusCode).toBe(400)
  })

  it('requires a session', async () => {
    const owner = await createActiveUser()
    const repo = await seedRepository(owner.id)
    const res = await app.inject({ method: 'GET', url: contentUrl(repo.id, 'src/build.ts') })
    expect(res.statusCode).toBe(401)
  })
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

describe('defaultBranch (addition 4)', () => {
  it('captures the remote HEAD branch on a real clone, and only for git repos', async () => {
    const bareDir = await makeTempDir('chapters-bare-')
    await simpleGit(bareDir).init(true)
    const workDir = await makeTempDir('chapters-work-')
    const git = simpleGit(workDir)
    await git.init()
    await git.addConfig('user.email', 'test@chapters.local')
    await git.addConfig('user.name', 'Test')
    await git.addRemote('origin', bareDir)
    await writeFile(join(workDir, 'a.ts'), 'export const a = 1')
    await git.add('.')
    await git.commit('initial')
    // Deliberately not "main": a hardcoded default would pass on the usual name.
    await git.push('origin', 'HEAD:refs/heads/trunk')
    await simpleGit(bareDir).raw(['symbolic-ref', 'HEAD', 'refs/heads/trunk'])

    const owner = await createActiveUser()
    const [gitRepo] = await db
      .insert(repositories)
      .values({
        name: 'branch-test',
        ownerId: owner.id,
        ingestionMethod: 'git',
        gitUrl: `file://${bareDir}`,
      })
      .returning()
    // Null until a sync has actually read a clone's HEAD.
    expect(gitRepo!.defaultBranch).toBeNull()

    await syncGitRepository(gitRepo!.id)
    const synced = (await db.select().from(repositories).where(eq(repositories.id, gitRepo!.id)))[0]
    expect(synced!.defaultBranch).toBe('trunk')
    expect(synced!.lastSyncedAt).toBeTruthy()

    // A non-git repository has no branch and never grows one.
    const pushRepo = await seedRepository(owner.id)
    const untouched = (await db.select().from(repositories).where(eq(repositories.id, pushRepo.id)))[0]
    expect(untouched!.defaultBranch).toBeNull()
  }, 30000)
})
