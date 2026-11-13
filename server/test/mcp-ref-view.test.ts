import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { db } from '../src/db/client.js'
import { blocks, repositories, repositoryFiles, repositoryShares, teams, teamMemberships } from '../src/db/schema.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { clearRefCache, REF_LIMITS, refCacheStats, repositoryViewAt } from '../src/repositories/ref-index.js'
import { viewQueries, refQueryStats } from '../src/repositories/ref-queries.js'
import { refSearchStats } from '../src/repositories/ref-search.js'
import { gitMirrorDir, removeGitMirror, withMirrorLock } from '../src/repositories/git-mirror.js'
import { parseCacheStats } from '../src/repositories/blob-cache.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
let owner: Client
let viewer: Client
let viewerId: string
let ownerEmail: string
let repoId: string
let localId: string
let root: string
let localRoot: string
let first: string
let second: string
let sameTree: string
let port: number
const git = () => simpleGit(root)
const BASE = 'export function retained() { return 1 }\nexport function removed() { return 2 }\n'
const NEXT = 'export function inserted() { return 8 }\nexport function retained() { return 3 }\n'
const CALLER = 'import { retained } from "./api.js"\nexport function entry() { return retained() }\n'
const EDITED = 'export function overlayOnly() { return 9 }\nexport function retained() { return 4 }\n'
const OVERLAY = `diff --git a/src/api.ts b/src/api.ts
--- a/src/api.ts
+++ b/src/api.ts
@@ -1,2 +1,2 @@
-export function inserted() { return 8 }
-export function retained() { return 3 }
+export function overlayOnly() { return 9 }
+export function retained() { return 4 }
diff --git a/src/fresh.ts b/src/fresh.ts
--- /dev/null
+++ b/src/fresh.ts
@@ -0,0 +1,2 @@
+import { retained } from "./api.js"
+export function freshCaller() { return retained() }
diff --git a/deleted.txt b/deleted.txt
--- a/deleted.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-delete this line
`
async function connect(email: string, name: string): Promise<Client> {
  const cookie = await loginCookie(app, email)
  const mint = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name, scope: 'account', profile: 'admin' } })
  const client = new Client({ name, version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${mint.json<{ token: string }>().token}` } } }))
  return client
}
const ROW = z.looseObject({ path: z.string().optional(), name: z.string().optional(), symbolName: z.string().optional(), snippet: z.string().optional(), at: z.string().optional(), to: z.string().optional(), startLine: z.number().optional(), endLine: z.number().optional(), edge: z.looseObject({ confidence: z.string(), kind: z.string(), col: z.number(), symbol: z.string().nullable() }).optional() })
const BODY = z.looseObject({
  results: z.array(ROW).default([]), files: z.array(ROW).default([]), hits: z.array(ROW).optional(), depth1: z.array(ROW).default([]), textual: z.array(ROW).optional(),
  content: z.string().optional(), diff: z.string().optional(),
  truncated: z.union([z.literal(false), z.looseObject({ cursor: z.string().optional() })]).optional(),
})

async function call(name: string, args: Record<string, unknown>, client = owner) {
  resetRateLimits()
  const result = await client.callTool({ name, arguments: { repositoryId: repoId, budget_tokens: 10_000, ...args } })
  const text = (result.content as Array<{ text?: string }>).map((p) => p.text ?? '').join('')
  return { error: result.isError === true, text, body: BODY.parse(JSON.parse(text)) }
}
async function answer(name: string, args: Record<string, unknown>, client = owner) {
  const result = await call(name, args, client)
  expect(result.error, result.text).toBe(false)
  return result.body
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'elara-ref-676-'))
  await mkdir(join(root, 'src'))
  await git().raw(['init', '--quiet', '--initial-branch=main'])
  await git().addConfig('user.email', 'ref-test@elara.local')
  await git().addConfig('user.name', 'Ref test')
  await writeFile(join(root, 'src/api.ts'), BASE)
  await writeFile(join(root, 'src/entry.ts'), CALLER)
  await writeFile(join(root, 'deleted.txt'), 'delete this line\n')
  await writeFile(join(root, 'no-newline.txt'), 'original')
  await writeFile(join(root, 'large.txt'), 'a long repeated passage for this private session only\n'.repeat(100))
  await writeFile(join(root, 'empty.ts'), '')
  await writeFile(join(root, 'side.ts'), 'import "./empty.js"\n')
  await writeFile(join(root, 'binary.dat'), Buffer.from([0, 1, 2]))
  await writeFile(join(root, 'invalid.txt'), Buffer.from([255, 254]))
  await writeFile(join(root, 'mode.sh'), 'echo unchanged\n')
  await git().add('.')
  await git().commit('base')
  first = (await git().revparse(['HEAD'])).trim()
  await git().checkoutLocalBranch('feature')
  await writeFile(join(root, 'src/api.ts'), NEXT)
  await writeFile(join(root, 'no-newline.txt'), 'replacement')
  await writeFile(join(root, 'binary.dat'), Buffer.from([0, 9, 2]))
  await writeFile(join(root, 'invalid.txt'), Buffer.from([255, 253]))
  await git().add('.')
  await git().raw(['update-index', '--chmod=+x', 'mode.sh'])
  await git().commit('feature')
  second = (await git().revparse(['HEAD'])).trim()
  await git().raw(['commit', '--allow-empty', '-m', 'same tree, another commit'])
  sameTree = (await git().revparse(['HEAD'])).trim()
  await git().addTag('same-tree')
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  port = typeof address === 'object' && address ? address.port : 0
  const user = await createActiveUser()
  ownerEmail = user.email
  const other = await createActiveUser()
  viewerId = other.id
  owner = await connect(user.email, 'ref-owner')
  viewer = await connect(other.email, 'ref-viewer')
  const [repo] = await db.insert(repositories).values({ ownerId: user.id, name: 'refs-676', ingestionMethod: 'git', gitUrl: `file://${root}`, lastSyncedCommit: first }).returning()
  repoId = repo!.id
  await syncRepositoryFiles(repoId, [{ path: 'src/api.ts', content: BASE }, { path: 'src/entry.ts', content: CALLER }], ['src/api.ts', 'src/entry.ts'], { commit: first })
  await flushExtraction()
  await db.insert(repositoryShares).values({ repositoryId: repoId, granteeType: 'user', granteeId: viewerId })
  await mkdir(config.localReposRoot, { recursive: true })
  localRoot = await mkdtemp(join(config.localReposRoot, 'ref-local-'))
  await simpleGit().clone(root, localRoot, ['--quiet'])
  const [local] = await db.insert(repositories).values({ ownerId: user.id, name: 'local-refs-676', ingestionMethod: 'local_path', localPath: localRoot }).returning()
  localId = local!.id
  clearRefCache()
}, 120_000)

afterAll(async () => {
  await owner?.close()
  await viewer?.close()
  await app?.close()
  if (repoId) await removeGitMirror(repoId)
  if (localId) await removeGitMirror(localId)
  if (root) await rm(root, { recursive: true, force: true })
  if (localRoot) await rm(localRoot, { recursive: true, force: true })
  clearRefCache()
})

describe('ref and overlay consumers (#676/#471)', () => {
  it('serves commit-bound bytes, targeted symbols and outlines instead of current shared rows', async () => {
    expect((await answer('read_file', { path: 'src/api.ts' })).commit).toBe(first)
    const old = await answer('read_file', { path: 'src/api.ts', ref: first, outline: false })
    const next = await answer('read_file', { path: 'src/api.ts', ref: 'feature', outline: false })
    expect(old.content).toBe(BASE)
    expect(next.content).toBe(NEXT)
    expect(next.commit).toBe(sameTree)
    const target = await answer('read_file', { path: 'src/api.ts', ref: second, targets: [{ symbol: 'inserted' }] })
    expect(JSON.stringify(target.parts)).toContain('return 8')
    const outlined = await answer('read_file', { path: 'src/api.ts', ref: second, outline: true })
    expect(JSON.stringify(outlined.outline)).toContain('inserted')
    const unchanged = await answer('read_file', { path: 'src/api.ts', ref: second, if_rev: next.hash })
    expect(unchanged).toMatchObject({ unchanged: true, commit: second })
  })

  it('resolves branches and tags once and reuses real tree/blob/parse/embed work while naming each actual commit', async () => {
    await answer('find_symbols', { query: 'inserted', ref: second })
    const before = { ...refCacheStats }
    const parsed = { ...parseCacheStats }
    const embedded = refSearchStats.embedded
    const reused = await answer('find_symbols', { query: 'inserted', ref: 'same-tree' })
    expect(reused.commit).toBe(sameTree)
    expect(refCacheStats.built).toBe(before.built)
    expect(refCacheStats.blobsRead).toBe(before.blobsRead)
    expect(refCacheStats.reused).toBe(before.reused + 1)
    expect(parseCacheStats).toEqual(parsed)
    expect(refSearchStats.embedded).toBe(embedded)
    expect(reused.results[0]).toMatchObject({ path: 'src/api.ts', name: 'inserted', startLine: 1 })
    await answer('search', { query: 'who calls retained', ref: second })
    const graph = { ...refQueryStats }
    const graphReuse = await answer('search', { query: 'who calls retained', ref: 'same-tree' })
    expect(graphReuse.commit).toBe(sameTree)
    expect(refQueryStats.built).toBe(graph.built)
    expect(refQueryStats.reused).toBe(graph.reused + 1)
  })

  it('searches both channels on the selected ref and never substitutes the default-index symbol set', async () => {
    const found = await answer('search', { query: 'inserted', ref: second, route: 'conceptual' })
    expect(found.retrieval_mode ?? found.retrieval).toBe('hybrid')
    expect(found.results.some((r) => r.path === 'src/api.ts' && r.snippet?.includes('inserted'))).toBe(true)
    const symbols = await answer('find_symbols', { query: 'removed', ref: second })
    expect(symbols.results.some((r) => r.name === 'removed')).toBe(false)
    expect((await answer('find_symbols', { query: 'removed', ref: first })).results[0]?.name).toBe('removed')
  })

  it('composes all actual public routes with immutable bytes and private overlays, keeping textual sites separate', async () => {
    const overlay = OVERLAY + `diff --git a/src/guess.ts b/src/guess.ts
--- /dev/null
+++ b/src/guess.ts
@@ -0,0 +1,1 @@
+export function guessed() { return retained() }
diff --git a/src/store.ts b/src/store.ts
--- /dev/null
+++ b/src/store.ts
@@ -0,0 +1,1 @@
+export class Store { save() { return 1 } }
diff --git a/src/retained.test.ts b/src/retained.test.ts
--- /dev/null
+++ b/src/retained.test.ts
@@ -0,0 +1,2 @@
+import { retained } from "./api.js"
+export function checksRetained() { return retained() }
`
    const exact = await answer('search', { query: 'inserted', ref: second })
    expect(exact).toMatchObject({ route: 'identifier', retrieval_mode: 'exact', confidence: 1, commit: second })
    expect(exact.results[0]).toMatchObject({ path: 'src/api.ts', symbolName: 'inserted', startLine: 1 })
    expect(exact.results[0]).not.toHaveProperty('updated')
    const file = await answer('search', { query: 'src/api.ts', route: 'path', ref: second, overlay })
    expect(file).toMatchObject({ route: 'path', retrieval_mode: 'exact', commit: second, overlay: true })
    expect(file.results[0]?.snippet).toBe(EDITED)
    expect(JSON.stringify(file.results[0]?.outline)).toContain('overlayOnly')
    const baseName = await answer('search', { query: 'Store.ts', ref: second, overlay })
    expect(baseName).toMatchObject({ route: 'path', retrieval_mode: 'exact' })
    expect(baseName.results[0]?.path).toBe('src/store.ts')
    const dotted = await answer('search', { query: 'Store.save', ref: second, overlay })
    expect(dotted).toMatchObject({ route: 'identifier', retrieval_mode: 'exact' })
    expect(dotted.results[0]).toMatchObject({ path: 'src/store.ts', symbolName: 'save', symbolParent: 'Store' })
    const defined = await answer('search', { query: 'defined in overlayOnly', route: 'structural', ref: second, overlay })
    expect(defined).toMatchObject({ route: 'structural', retrieval_mode: 'exact' })
    expect(defined.results[0]).toMatchObject({ path: 'src/api.ts', symbolName: 'overlayOnly', startLine: 1 })
    const callers = await answer('search', { query: 'who calls retained', ref: second, overlay })
    expect(callers).toMatchObject({ route: 'structural', retrieval_mode: 'exact', commit: second, overlay: true })
    expect(callers.results.map((r) => r.path)).toEqual(['src/entry.ts', 'src/fresh.ts', 'src/retained.test.ts'])
    expect(callers.results.every((r) => r.edge?.confidence === 'resolved')).toBe(true)
    expect(callers.textual).toEqual([expect.objectContaining({ path: 'src/guess.ts', line: 1, confidence: 'textual' })])
    const references = await answer('search', { query: 'references to retained', route: 'structural', ref: second, overlay })
    expect(references.results.every((r) => r.edge?.confidence === 'resolved')).toBe(true)
    expect(references.textual).toEqual([expect.objectContaining({ path: 'src/guess.ts', confidence: 'textual' })])
    const tests = await answer('search', { query: 'tests for retained', route: 'structural', ref: second, overlay })
    expect(tests.results.map((r) => r.path)).toEqual(['src/retained.test.ts'])
    const imports = await answer('search', { query: 'what imports empty.ts', route: 'structural', ref: second, overlay })
    expect(imports.results).toEqual([expect.objectContaining({ path: 'src/side.ts', startLine: 1, edge: expect.objectContaining({ kind: 'import' }) })])
    const conceptual = await answer('search', { query: 'retained', route: 'conceptual', ref: second, overlay })
    expect(conceptual).toMatchObject({ route: 'conceptual', retrieval_mode: 'hybrid', commit: second })
    expect(conceptual.results.some((r) => r.symbolName === 'retained')).toBe(true)
    for (const [query, route] of [['retained', 'path'], ['src/api.ts', 'identifier']] as const) {
      const fallback = await answer('search', { query, route, ref: second, overlay })
      expect(fallback).toMatchObject({ route: 'conceptual', attempted_route: route, retrieval_mode: 'fallback', underlying_retrieval_mode: 'hybrid' })
    }
    const deleted = await answer('search', { query: 'inserted', ref: second, overlay })
    expect(deleted).toMatchObject({ route: 'conceptual', attempted_route: 'identifier', retrieval_mode: 'fallback' })
    expect(deleted.results.some((r) => r.symbolName === 'inserted')).toBe(false)
    const privateMiss = await answer('search', { query: 'overlayOnly', ref: second })
    expect(privateMiss.results.some((r) => r.symbolName === 'overlayOnly')).toBe(false)
  })

  it('continues grep by the established scalar position without skipping lines or crossing overlay views', async () => {
    const args = { ref: second, pattern: 'long repeated', path: 'large.txt' }
    const firstPage = await answer('grep', args)
    expect(firstPage.hits?.map((h) => h.line)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    if (!firstPage.truncated || !firstPage.truncated.cursor) throw new Error('expected grep continuation')
    const nextPage = await answer('grep', { ...args, cursor: firstPage.truncated.cursor })
    expect(nextPage.hits?.map((h) => h.line)).toEqual(Array.from({ length: 20 }, (_, i) => i + 21))
    expect((await call('grep', { ...args, overlay: OVERLAY, cursor: firstPage.truncated.cursor })).error).toBe(true)
  })

  it('applies additions, modifications and deletions to reads, grep, hybrid search, browse, refs and the map', async () => {
    const args = { ref: second, overlay: OVERLAY }
    const read = await answer('read_file', { ...args, path: 'src/api.ts', outline: false })
    expect(read.content).toBe(EDITED)
    expect(read).toMatchObject({ commit: second, overlay: true })
    expect((await call('read_file', { ...args, path: 'deleted.txt' })).error).toBe(true)
    const grep = await answer('grep', { ...args, pattern: 'overlayOnly|inserted|delete this line', context: 0 })
    expect(grep.hits).toEqual([expect.objectContaining({ path: 'src/api.ts', line: 1, snippet: EDITED.split('\n')[0] })])
    expect((await answer('find_symbols', { ...args, query: 'overlayOnly' })).results[0]).toMatchObject({ name: 'overlayOnly', startLine: 1 })
    expect((await answer('find_symbols', { ...args, query: 'inserted' })).results.some((r) => r.name === 'inserted')).toBe(false)
    expect((await answer('search', { ...args, query: 'overlayOnly' })).results.some((r) => r.snippet?.includes('overlayOnly'))).toBe(true)
    const files = await answer('browse_repository', args)
    expect(files.files.some((f) => f.path === 'src/fresh.ts')).toBe(true)
    expect(files.files.some((f) => f.path === 'deleted.txt')).toBe(false)
    const refs = await answer('find_symbols', { ...args, query: 'retained', refs: 'callers' })
    expect(refs.results.map((r) => r.at)).toEqual(['src/entry.ts:2', 'src/fresh.ts:2'])
    const at = await answer('find_symbols', { ...args, query: 'src/fresh.ts:2', refs: 'at' })
    expect(at.symbol).toMatchObject({ name: 'freshCaller', line: 2 })
    expect(at.results.some((r) => r.to === 'src/api.ts#retained')).toBe(true)
    const impact = await answer('find_symbols', { ...args, query: 'retained', refs: 'impact' })
    expect(impact.depth1.map((r) => r.at)).toContain('src/fresh.ts:2')
    const explain = await answer('find_symbols', { ...args, query: 'overlayOnly', refs: 'explain' })
    expect(explain.symbol).toMatchObject({ name: 'overlayOnly', line: 1 })
    expect(JSON.stringify(await answer('orient', { ...args, path: 'src' }))).toContain('overlayOnly')
  })

  it('validates the blob base rather than trusting still-applicable context, and refuses input paths/rev expressions', async () => {
    const stale = OVERLAY.replace('--- a/src/api.ts', 'index 1234567..abcdef0 100644\n--- a/src/api.ts')
    expect((await call('read_file', { ref: second, overlay: stale, path: 'src/api.ts' })).text).toContain('stale overlay base')
    for (const ref of ['--help', 'HEAD~1', 'main:src/api.ts', '../outside', '/tmp/source']) expect((await call('read_file', { ref, path: 'src/api.ts' })).error).toBe(true)
    expect((await call('read_file', { ref: second, overlay: OVERLAY.replace(/src\/fresh.ts/g, '../outside.ts'), path: 'src/api.ts' })).error).toBe(true)
    expect((await call('search', { ref: second, query: 'retained', everywhere: true })).error).toBe(true)
    const binaryAddition = '--- /dev/null\n+++ b/binary.dat\n@@ -0,0 +1,1 @@\n+pretend this existing binary was absent\n'
    expect((await call('read_file', { ref: second, overlay: binaryAddition, path: 'binary.dat' })).text).toContain('base does not match')
    const incompleteDeletion = '--- a/deleted.txt\n+++ /dev/null\n@@ -1,1 +1,1 @@\n-delete this line\n+\n'
    expect((await call('read_file', { ref: second, overlay: incompleteDeletion, path: 'deleted.txt' })).text).toContain('deletion does not remove all')
  })

  it('does not persist overlay files/symbols or expose them to another/no-overlay session', async () => {
    const before = await db.select().from(repositoryFiles).where(eq(repositoryFiles.repositoryId, repoId))
    const beforeBlocks = await db.select().from(blocks).where(eq(blocks.containerId, repoId))
    const parsed = { ...parseCacheStats }
    await answer('find_symbols', { ref: second, overlay: OVERLAY, query: 'overlayOnly' })
    expect(await db.select().from(repositoryFiles).where(eq(repositoryFiles.repositoryId, repoId))).toEqual(before)
    expect(await db.select().from(blocks).where(eq(blocks.containerId, repoId))).toEqual(beforeBlocks)
    expect(parseCacheStats).toEqual(parsed)
    expect((await answer('find_symbols', { ref: second, query: 'overlayOnly' }, viewer)).results.some((r) => r.name === 'overlayOnly')).toBe(false)
    const firstRead = await answer('read_file', { ref: second, overlay: OVERLAY, path: 'large.txt', session_id: 'private-session', outline: false })
    expect(JSON.stringify(firstRead)).not.toContain('same_as')
    const privateRead = await answer('read_file', { ref: second, path: 'large.txt', session_id: 'private-session', outline: false }, viewer)
    expect(JSON.stringify(privateRead)).not.toContain('same_as')
  })

  it('checks live share permissions before a cached tree and before cursor continuation', async () => {
    const paged = await answer('read_file', { ref: second, path: 'large.txt', outline: false, budget_tokens: 256 }, viewer)
    if (!paged.truncated) throw new Error('expected a continuation')
    expect(paged.truncated.cursor).toBeTruthy()
    await db.delete(repositoryShares).where(and(eq(repositoryShares.repositoryId, repoId), eq(repositoryShares.granteeType, 'user'), eq(repositoryShares.granteeId, viewerId)))
    const before = { ...refCacheStats }
    expect((await call('read_file', { ref: second, path: 'large.txt', outline: false, cursor: paged.truncated.cursor }, viewer)).error).toBe(true)
    expect(refCacheStats).toEqual(before)
    await db.insert(repositoryShares).values({ repositoryId: repoId, granteeType: 'user', granteeId: viewerId })
    expect((await answer('read_file', { ref: second, path: 'src/api.ts' }, viewer)).commit).toBe(second)
  })

  it('invalidates a cached tree and cursor on team membership removal and on regrant', async () => {
    await db.delete(repositoryShares).where(and(eq(repositoryShares.repositoryId, repoId), eq(repositoryShares.granteeType, 'user'), eq(repositoryShares.granteeId, viewerId)))
    const [team] = await db.insert(teams).values({ name: 'ref-team' }).returning()
    try {
      await db.insert(repositoryShares).values({ repositoryId: repoId, granteeType: 'team', granteeId: team!.id })
      await db.insert(teamMemberships).values({ teamId: team!.id, userId: viewerId })
      const held = await answer('read_file', { ref: second, path: 'large.txt', outline: false, budget_tokens: 256 }, viewer)
      if (!held.truncated) throw new Error('expected a continuation')
      await db.delete(teamMemberships).where(eq(teamMemberships.teamId, team!.id))
      expect((await call('read_file', { ref: second, path: 'src/api.ts' }, viewer)).error).toBe(true)
      await db.insert(teamMemberships).values({ teamId: team!.id, userId: viewerId })
      const stale = await call('read_file', { ref: second, path: 'large.txt', outline: false, cursor: held.truncated.cursor }, viewer)
      expect(stale.error).toBe(true)
      expect(stale.text).toMatch(/cursor/i)
    } finally {
      await db.delete(repositoryShares).where(and(eq(repositoryShares.repositoryId, repoId), eq(repositoryShares.granteeType, 'team'), eq(repositoryShares.granteeId, team!.id)))
      await db.delete(teams).where(eq(teams.id, team!.id))
      await db.insert(repositoryShares).values({ repositoryId: repoId, granteeType: 'user', granteeId: viewerId })
    }
  })

  it('binds continuations to immutable commits even when a branch moves', async () => {
    const args = { ref: 'moving', path: 'large.txt', outline: false }
    await git().raw(['branch', 'moving', second])
    const paged = await answer('read_file', { ...args, budget_tokens: 256 })
    if (!paged.truncated) throw new Error('expected a continuation')
    await git().raw(['branch', '-f', 'moving', first])
    const changed = await call('read_file', { ...args, cursor: paged.truncated.cursor })
    expect(changed.error).toBe(true)
    expect(changed.text).toMatch(/cursor/i)
  })

  it('returns an actual commit-to-commit patch and includes the selected overlay without newline corruption', async () => {
    const diff = await answer('browse_repository', { ref: second, diff: first, path: 'src/api.ts' })
    expect(diff).toMatchObject({ commit: second, base: { commit: first } })
    expect(diff.diff).toContain('-export function removed() { return 2 }')
    expect(diff.diff).toContain('+export function inserted() { return 8 }')
    const edited = await answer('browse_repository', { ref: second, diff: first, overlay: OVERLAY })
    expect(edited.diff).toContain('+export function overlayOnly() { return 9 }')
    expect(edited.diff).toContain('+++ "b/src/fresh.ts"')
    expect(edited.diff).toContain('\\ No newline at end of file')
    expect((await answer('read_file', { ref: second, path: 'no-newline.txt', outline: false })).content).toBe('replacement')
    const modes = await answer('browse_repository', { ref: second, diff: first })
    expect(modes.diff).toContain('old mode 100644\nnew mode 100755')
    expect(modes.metadata).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'binary.dat', kind: 'modified', reason: 'binary', before: { sha: expect.stringMatching(/^[a-f0-9]{40}$/), mode: '100644' }, after: { sha: expect.stringMatching(/^[a-f0-9]{40}$/), mode: '100644' } }),
      expect.objectContaining({ path: 'invalid.txt', reason: 'binary' }),
    ]))
    expect((await call('read_file', { ref: second, path: 'invalid.txt' })).text).toContain('no indexed UTF-8 text')
  })

  it('uses only the registered local Git root, excludes its dirty worktree, and clearly refuses push-only refs', async () => {
    await writeFile(join(localRoot, 'src/api.ts'), 'export function uncommittedLeak() {}\n')
    await simpleGit(localRoot).raw(['replace', first, second])
    const local = await answer('read_file', { repositoryId: localId, ref: first, path: 'src/api.ts', outline: false })
    expect(local.content).toBe(BASE)
    expect(local.commit).toBe(first)
    await simpleGit(localRoot).raw(['replace', '-d', first])
    const [push] = await db.insert(repositories).values({ name: 'push-no-ref', ownerId: (await db.select().from(repositories).where(eq(repositories.id, repoId)))[0]!.ownerId, ingestionMethod: 'agent_push' }).returning()
    try { expect((await call('read_file', { repositoryId: push!.id, ref: first, path: 'src/api.ts' })).text).toContain('no Git refs') }
    finally { await db.delete(repositories).where(eq(repositories.id, push!.id)) }
  })

  it('uses real module imports for side-effect imports of an empty file, including overlay destinations', async () => {
    const [record] = await db.select().from(repositories).where(eq(repositories.id, repoId))
    const view = await repositoryViewAt(record!.ownerId, repoId, { ref: second })
    const target = { wholeFile: true as const, fileId: view.files.get('empty.ts')!.id, blockIds: [], name: 'empty.ts', symbol: 'empty.ts' }
    expect(await viewQueries(view).codeSites(repoId, target, ['import'], { limit: 10, offset: 0 })).toEqual([
      expect.objectContaining({ path: 'side.ts', line: 1, kind: 'import', confidence: 'resolved', context: 'import "./empty.js"' }),
    ])
    const overlay = OVERLAY + '--- a/side.ts\n+++ b/side.ts\n@@ -1,1 +1,1 @@\n-import "./empty.js"\n+import "./src/fresh.js"\n'
    const edited = await repositoryViewAt(record!.ownerId, repoId, { ref: second, overlay })
    const queries = viewQueries(edited)
    expect(await queries.codeSites(repoId, target, ['import'], { limit: 10, offset: 0 })).toEqual([])
    await expect(queries.codeSites('00000000-0000-4000-8000-000000000000', target, ['import'], { limit: 10, offset: 0 })).rejects.toThrow(/selected repository view/)
    const fresh = { ...target, fileId: edited.files.get('src/fresh.ts')!.id, name: 'src/fresh.ts', symbol: 'src/fresh.ts' }
    expect((await queries.codeSites(repoId, fresh, ['import'], { limit: 10, offset: 0 }))[0]).toMatchObject({ path: 'side.ts', line: 1, confidence: 'resolved' })
    const result = await answer('search', { ref: second, query: 'empty.ts' })
    expect(result.results.find((r) => r.path === 'empty.ts')).not.toHaveProperty('startLine')
  })

  it('purges the owned query mirror and never reuses the old source identity after recreation at the same id', async () => {
    const [source] = await db.select().from(repositories).where(eq(repositories.id, repoId))
    const [temporary] = await db.insert(repositories).values({ name: 'ref-purge', ownerId: source!.ownerId, ingestionMethod: 'git', gitUrl: `file://${root}` }).returning()
    const id = temporary!.id
    try {
      const old = await answer('read_file', { repositoryId: id, ref: second, path: 'src/api.ts' })
      const cookie = await loginCookie(app, ownerEmail)
      const deleted = await app.inject({ method: 'DELETE', url: `/api/repositories/${id}`, headers: { cookie } })
      expect(deleted.statusCode).toBe(200)
      await withMirrorLock(id, async () => { expect(existsSync(gitMirrorDir(id))).toBe(false) })
      expect((await call('read_file', { repositoryId: id, ref: second, path: 'src/api.ts' })).error).toBe(true)
      await db.insert(repositories).values({ id, name: 'ref-recreated', ownerId: source!.ownerId, ingestionMethod: 'git', gitUrl: `file://${root}`, createdAt: new Date(temporary!.createdAt.getTime() + 1_000) })
      const before = refCacheStats.built
      const fresh = await answer('read_file', { repositoryId: id, ref: second, path: 'src/api.ts' })
      expect(fresh.source).not.toBe(old.source)
      expect(refCacheStats.built).toBe(before + 1)
    } finally {
      await db.delete(repositories).where(eq(repositories.id, id))
      await removeGitMirror(id)
    }
  })

  it('isolates source identity and refuses an oversized tree instead of returning an incomplete successful index', async () => {
    const old = await answer('read_file', { ref: second, path: 'src/api.ts' })
    const otherRoot = await mkdtemp(join(tmpdir(), 'elara-ref-other-'))
    try {
      await simpleGit().clone(root, otherRoot, ['--quiet'])
      await db.update(repositories).set({ gitUrl: `file://${otherRoot}` }).where(eq(repositories.id, repoId))
      const next = await answer('read_file', { ref: second, path: 'src/api.ts' })
      expect(next.source).not.toBe(old.source)
      expect(next.commit).toBe(second)
      const cap = REF_LIMITS.files
      try {
        REF_LIMITS.files = 1
        clearRefCache()
        expect((await call('read_file', { ref: second, path: 'src/api.ts' })).error).toBe(true)
      } finally { REF_LIMITS.files = cap }
    } finally {
      await db.update(repositories).set({ gitUrl: `file://${root}` }).where(eq(repositories.id, repoId))
      await rm(otherRoot, { recursive: true, force: true })
    }
    expect(gitMirrorDir(repoId)).not.toContain(root)
  })
})
