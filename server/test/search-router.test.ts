// Consumer-visible routing and unchanged conceptual retrieval (#1060).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { db } from '../src/db/client.js'
import { repositories, vaults } from '../src/db/schema.js'
import { createNote } from '../src/notes/store.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
import { classifyQuery, routeTerm } from '../src/search/router.js'
import { classifyStructural } from '../src/search/structural.js'
import { searchNotes } from '../src/search/search.js'
import { createActiveUser, loginCookie } from './helpers.js'

let repoId: string
let vaultId: string
const code = { vaultIds: [] as string[], repositoryIds: [] as string[] }
let app: FastifyInstance
let agent: Client
let cookie: string

beforeAll(async () => {
  const user = await createActiveUser()
  const [r] = await db.insert(repositories).values({ name: 'router-repo', ownerId: user.id, ingestionMethod: 'agent_push' }).returning()
  repoId = r!.id
  const [v] = await db.insert(vaults).values({ name: 'router-vault', ownerId: user.id }).returning()
  vaultId = v!.id
  code.repositoryIds = [repoId]
  const files = [
    { path: 'src/notes/frontmatter.ts', content: 'export function parseFrontmatter(text: string): string {\n  return text.trim()\n}\n\nexport function renderFrontmatter(value: string): string {\n  return value\n}\n' },
    { path: 'src/store.ts', content: 'export class Store {\n  save(item: string): string {\n    return item\n  }\n}\n' },
    { path: 'src/Uppercase.ts', content: 'export const uppercaseFileToken = 1\n' },
    { path: 'src/lower-holder.ts', content: 'export class holder {\n  save() { return \"lower\" }\n}\n' },
    { path: 'src/a/parse.ts', content: 'export function parse(s: string): string {\n  return s\n}\n' },
    { path: 'src/b/parse.ts', content: 'export function parse(s: string): string {\n  return s.toLowerCase()\n}\n' },
    { path: 'src/caller.ts', content: 'import { parseFrontmatter } from \"./notes/frontmatter.js\";\nexport function caller() { return parseFrontmatter(\"x\") }\n' },
    { path: 'src/textual.ts', content: 'export function textual() { return parseFrontmatter(\"x\") }\n' },
    { path: 'src/frontmatter.test.ts', content: 'import { parseFrontmatter } from \"./notes/frontmatter.js\";\nexport function check() { return parseFrontmatter(\"test\") }\n' },
    { path: 'src/empty.ts', content: '' },
    { path: 'src/modules.ts', content: 'import \"./empty.js\";\nimport \"./notes/frontmatter.js\";\n' },
    { path: 'docs/readme.md', content: '# Readme\n\nparseFrontmatter is described in the frontmatter module.\n' },
  ]
  await syncRepositoryFiles(repoId, files, files.map((f) => f.path))
  await createNote(vaultId, { path: 'docs/guide', body: '# Guide\n\nHow the parseFrontmatter helper is used.\n' })
  await flushExtraction()
  await flushEmbeddings()
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  cookie = await loginCookie(app, user.email)
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: 'router-test', scope: 'account', access: 'read' } })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('missing listener')
  agent = new Client({ name: 'router-test', version: '1' })
  await agent.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } } }))
}, 120_000)

afterAll(async () => {
  await agent?.close()
  await app?.close()
})

const ask = (query: string, symbols = true) => searchNotes(code, query, 10, {}, { includeSymbols: symbols })

describe('the term a query asks for', () => {
  it('is the one word left once the filler is dropped, or the one backticked token', () => {
    expect(routeTerm('parseFrontmatter')).toBe('parseFrontmatter')
    expect(routeTerm('where is parseFrontmatter defined?')).toBe('parseFrontmatter')
    expect(routeTerm('Where is `Store.save` implemented')).toBe('Store.save')
    expect(routeTerm('src/store.ts')).toBe('src/store.ts')
    expect(routeTerm('how does the parser handle `parseFrontmatter` when the text has no fence')).toBeNull()
    expect(routeTerm('where are MCP rate limits enforced')).toBeNull()
    expect(routeTerm('parse frontmatter')).toBeNull()
    // A verb around a backticked term asks for more than the term: not an identifier lookup.
    for (const q of ['who calls `parseFrontmatter`', 'tests for `parseFrontmatter`', 'references to `Store.save`']) expect(routeTerm(q), q).toBeNull()
    expect(routeTerm('./src/store.ts')).toBe('src/store.ts')
    expect(routeTerm('/src/store.ts')).toBe('src/store.ts')
    expect(routeTerm('ab')).toBeNull()
  })
  it('classifies all four shapes without routing prose that mentions a graph operation', () => {
    expect(classifyQuery('parseFrontmatter')).toBe('identifier')
    expect(classifyQuery('src/store.ts')).toBe('path')
    expect(classifyQuery('why does this parser preserve whitespace')).toBe('conceptual')
    for (const prefix of ['who calls', 'callers of', 'what imports', 'references to', 'tests for', 'defined in']) {
      expect(classifyQuery(`${prefix} \`parseFrontmatter\``)).toBe('structural')
      expect(classifyStructural(`explain ${prefix} parseFrontmatter`)).toBeNull()
    }
  })
})

describe('identifier route (#1060)', () => {
  it('one exact symbol is the answer, with its span and confidence 1, and nothing else', async () => {
    const res = await ask('parseFrontmatter')
    expect(res).toMatchObject({ status: 'ok', retrieval_mode: 'exact', degraded: false, route: 'identifier', confidence: 1 })
    expect(res.ambiguous).toBeUndefined()
    expect(res.results).toHaveLength(1)
    const [hit] = res.results
    expect(hit).toMatchObject({ resourceType: 'symbol', path: 'src/notes/frontmatter.ts', symbolName: 'parseFrontmatter', startLine: 1, endLine: 3, channel: 'exact' })
    expect(hit!.block).toMatch(/^b_[a-z2-7]{12}$/)
  })

  it('is asked in a sentence, by a snake_case spelling, or as Class.method', async () => {
    expect((await ask('where is parseFrontmatter defined?')).results.map((r) => r.symbolName)).toEqual(['parseFrontmatter'])
    expect((await ask('parse_frontmatter')).results.map((r) => r.symbolName)).toEqual(['parseFrontmatter'])
    const method = await ask('where is `Store.save` implemented')
    expect(method.route).toBe('identifier')
    expect(method.results.map((r) => `${r.symbolParent}.${r.symbolName}`)).toEqual(['Store.save'])
  })

  it('resolves dotted names and uppercase filenames by lookup, while overrides remain strict', async () => {
    expect(await ask('Uppercase.ts')).toMatchObject({ route: 'path', confidence: 1, results: [expect.objectContaining({ path: 'src/Uppercase.ts' })] })
    expect(await ask('holder.save')).toMatchObject({ route: 'identifier', confidence: 1, results: [expect.objectContaining({ symbolParent: 'holder', symbolName: 'save' })] })
    const pathOnly = await searchNotes(code, 'holder.save', 10, {}, { includeSymbols: true, route: 'path' })
    expect(pathOnly).toMatchObject({ route: 'conceptual', attempted_route: 'path', retrieval_mode: 'fallback' })
    const identifiersOnly = await searchNotes(code, 'Uppercase.ts', 10, {}, { includeSymbols: true, route: 'identifier' })
    expect(identifiersOnly).toMatchObject({ route: 'conceptual', attempted_route: 'identifier', retrieval_mode: 'fallback' })
  })

  it('several exact symbols are all listed, ambiguous, with no fuzzy hit added', async () => {
    const res = await ask('parse')
    expect(res).toMatchObject({ route: 'identifier', ambiguous: true, retrieval_mode: 'exact' })
    expect(res.confidence).toBeUndefined()
    expect(res.results.map((r) => r.path)).toEqual(['src/a/parse.ts', 'src/b/parse.ts'])
  })

  it('misses fall back honestly and conceptual answers retain the underlying bytes', async () => {
    for (const query of ['where is parseFrontmatterX defined?', '`parseFrontmatterX`']) {
      const missed = await ask(query)
      expect(missed).toMatchObject({ route: 'conceptual', attempted_route: 'identifier', retrieval_mode: 'fallback', underlying_retrieval_mode: 'hybrid' })
      expect(missed.confidence).toBeUndefined()
    }
    for (const query of ['how does the parser handle `parseFrontmatter` when the text has no fence', 'parseFrontmatter']) {
      const baseline = await searchNotes(code, query, 10, {}, { includeSymbols: false, route: false })
      const conceptual = await searchNotes(code, query, 10, {}, { includeSymbols: false, route: 'conceptual' })
      const automatic = await ask(query, false)
      expect(JSON.stringify(conceptual)).toBe(JSON.stringify(baseline))
      expect(JSON.stringify(automatic)).toBe(JSON.stringify(baseline))
    }
  })
})

describe('path route (#1060)', () => {
  it('a file path or a file name is that file, whole', async () => {
    const byPath = await ask('src/store.ts')
    expect(byPath).toMatchObject({ route: 'path', confidence: 1, retrieval_mode: 'exact' })
    expect(byPath.results).toHaveLength(1)
    expect(byPath.results[0]).toMatchObject({ resourceType: 'code', path: 'src/store.ts', startLine: 1, endLine: 5 })
    expect(byPath.results[0]!.outline).toMatchObject({ truncated: false, symbols: [expect.objectContaining({ name: 'Store' }), expect.objectContaining({ name: 'Store.save' })] })
    const byName = await ask('where is frontmatter.ts')
    expect(byName.results.map((r) => r.path)).toEqual(['src/notes/frontmatter.ts'])
  })

  it('two files of one name are both listed, ambiguous', async () => {
    const res = await ask('parse.ts')
    expect(res).toMatchObject({ route: 'path', ambiguous: true })
    expect(res.results.map((r) => r.path)).toEqual(['src/a/parse.ts', 'src/b/parse.ts'])
  })

  it('a note path is that note', async () => {
    const res = await searchNotes({ vaultIds: [vaultId], repositoryIds: [] }, 'docs/guide', 10)
    expect(res).toMatchObject({ route: 'path', confidence: 1 })
    expect(res.results.map((r) => `${r.resourceType}:${r.path}`)).toEqual(['note:docs/guide'])
    expect(res.results[0]!.outline).toMatchObject({ truncated: false, headings: [expect.objectContaining({ name: 'Guide' })] })
  })
})

describe('structural routes and public overrides', () => {
  it('separates resolved callers from textual edges and answers each graph shape', async () => {
    for (const query of ['who calls parseFrontmatter', 'callers of parseFrontmatter', 'references to parseFrontmatter']) {
      const res = await ask(query)
      expect(res).toMatchObject({ route: 'structural', retrieval_mode: 'exact', status: 'ok' })
      expect(res.results.some((r) => r.path === 'src/caller.ts')).toBe(true)
      expect(res.results.every((r) => r.edge?.confidence === 'resolved')).toBe(true)
      expect(res.results.some((r) => r.path === 'src/textual.ts')).toBe(false)
      expect(res.textual).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'src/textual.ts', confidence: 'textual' })]))
    }
    expect((await ask('tests for parseFrontmatter')).results.some((r) => r.path === 'src/frontmatter.test.ts')).toBe(true)
    expect((await ask('defined in parseFrontmatter')).results[0]).toMatchObject({ symbolName: 'parseFrontmatter', startLine: 1 })
    const none = await ask('who calls renderFrontmatter')
    expect(none).toMatchObject({ route: 'structural', retrieval_mode: 'exact', status: 'no_match', results: [] })
  })

  it('imports whole files, including empty modules, and labels ambiguous targets', async () => {
    for (const path of ['src/empty.ts', 'src/notes/frontmatter.ts']) {
      const res = await ask(`what imports ${path}`)
      expect(res).toMatchObject({ route: 'structural', retrieval_mode: 'exact' })
      expect(res.results).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'src/modules.ts', edge: expect.objectContaining({ kind: 'import' }) })]))
    }
    const ambiguous = await ask('callers of parse')
    expect(ambiguous).toMatchObject({ route: 'structural', ambiguous: true })
    expect(ambiguous.results.every((r) => r.resourceType === 'symbol')).toBe(true)
    expect((await ask('what imports missing.ts')).route).toBe('conceptual')
  })

  it('forced routes obey filters and preserve conceptual results rather than merging fuzzy candidates', async () => {
    const options = { includeSymbols: true, route: 'identifier' as const }
    const matched = await searchNotes(code, 'parse', 10, { path: 'src/a/' }, options)
    expect(matched).toMatchObject({ route: 'identifier', confidence: 1 })
    expect(matched.results.map((r) => r.path)).toEqual(['src/a/parse.ts'])
    const missing = await searchNotes(code, 'parse', 10, { path: 'not-here/' }, options)
    expect(missing).toMatchObject({ route: 'conceptual', attempted_route: 'identifier', results: [] })
    const conceptual = await searchNotes(code, 'parseFrontmatter', 10, {}, { includeSymbols: true, route: 'conceptual' })
    const exact = await ask('parseFrontmatter')
    expect(conceptual.route).toBe('conceptual')
    expect(conceptual.results.length).toBeGreaterThan(exact.results.length)
    for (const route of ['identifier', 'path', 'structural'] as const) {
      const res = await searchNotes({ vaultIds: [], repositoryIds: [] }, 'parseFrontmatter', 10, {}, { ...options, route })
      expect(res.results).toEqual([])
      expect(res.route).toBe('conceptual')
    }
  })

  it('REST and MCP expose all overrides with strict validation and budgeted graph evidence', async () => {
    for (const [route, query] of [['identifier', 'parseFrontmatter'], ['path', 'src/store.ts'], ['structural', 'who calls parseFrontmatter'], ['conceptual', 'parseFrontmatter']] as const) {
      const rest = await app.inject({ method: 'GET', url: `/api/repositories/${repoId}/search?q=${encodeURIComponent(query)}&symbols=true&route=${route}`, headers: { cookie } })
      expect(rest.statusCode).toBe(200)
      expect(rest.json().route).toBe(route)
      resetRateLimits()
      const response = await agent.callTool({ name: 'search', arguments: { repositoryId: repoId, query, route, budget_tokens: 1500 } })
      expect(response.isError).not.toBe(true)
      const text = (response.content as Array<{ text: string }>)[0]!.text
      const parsed = JSON.parse(text)
      expect(parsed.route).toBe(route)
      expect(text.length).toBeLessThanOrEqual(6000)
      if (route === 'structural') {
        expect(parsed.results.every((r: { edge: { confidence: string } }) => r.edge.confidence === 'resolved')).toBe(true)
        expect(parsed.textual.some((r: { confidence: string }) => r.confidence === 'textual')).toBe(true)
      }
    }
    expect((await app.inject({ method: 'GET', url: `/api/repositories/${repoId}/search?q=parse&route=fuzzy`, headers: { cookie } })).statusCode).toBe(400)
    resetRateLimits()
    expect((await agent.callTool({ name: 'search', arguments: { repositoryId: repoId, query: 'parse', route: 'fuzzy' } })).isError).toBe(true)
  })

  it('bounds graph work and outlines, and reports source caps separately from budget packing', async () => {
    const owner = await createActiveUser()
    const [repo] = await db.insert(repositories).values({ name: 'bounded-router', ownerId: owner.id, ingestionMethod: 'agent_push' }).returning()
    const files = [
      { path: 'target.ts', content: 'export function boundedTarget() {}' },
      ...Array.from({ length: 14 }, (_, i) => ({ path: `caller${String(i).padStart(2, '0')}.ts`, content: 'import { boundedTarget } from \"./target.js\";\nexport function invoke() { boundedTarget() }\n' })),
      { path: 'outline.ts', content: Array.from({ length: 105 }, (_, i) => `export function symbol${i}() {}`).join('\n') },
    ]
    await syncRepositoryFiles(repo!.id, files, files.map((f) => f.path))
    await flushExtraction()
    const scope = { vaultIds: [], repositoryIds: [repo!.id] }
    const graph = await searchNotes(scope, 'who calls boundedTarget', 5, {}, { route: 'structural' })
    expect(graph).toMatchObject({ route: 'structural', partial: true })
    expect(graph.results).toHaveLength(5)
    const outline = await searchNotes(scope, 'outline.ts', 10, {}, { route: 'path' })
    const outlineData = outline.results[0]!.outline
    expect(outlineData && 'symbols' in outlineData ? outlineData.symbols : []).toHaveLength(100)
    expect(outline.results[0]!.outline?.truncated).toBe(true)
    const ownerCookie = await loginCookie(app, owner.email)
    const granteeId = (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json().id
    const shared = await app.inject({ method: 'POST', url: `/api/repositories/${repo!.id}/shares`, headers: { cookie: ownerCookie }, body: { granteeType: 'user', granteeId } })
    expect(shared.statusCode).toBe(200)
    resetRateLimits()
    const packed = await agent.callTool({ name: 'search', arguments: { repositoryId: repo!.id, query: 'outline.ts', route: 'path', budget_tokens: 256 } })
    expect(packed.isError).not.toBe(true)
    const text = (packed.content as Array<{ text: string }>)[0]!.text
    const parsed = JSON.parse(text)
    expect(text.length).toBeLessThanOrEqual(1024)
    expect(parsed.route).toBe('path')
    expect(parsed.truncated).not.toBe(false)
  })

  it('does not read a foreign repository and cannot retain a revoked share', async () => {
    const foreign = await createActiveUser()
    const [repo] = await db.insert(repositories).values({ name: 'foreign-router', ownerId: foreign.id, ingestionMethod: 'agent_push' }).returning()
    await syncRepositoryFiles(repo!.id, [{ path: 'src/store.ts', content: 'export function privateRouter() {}' }], ['src/store.ts'])
    await flushExtraction()
    expect((await ask('privateRouter')).results.some((r) => r.containerId === repo!.id)).toBe(false)
    const foreignCookie = await loginCookie(app, foreign.email)
    const granteeId = (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json().id
    const granted = await app.inject({ method: 'POST', url: `/api/repositories/${repo!.id}/shares`, headers: { cookie: foreignCookie }, body: { granteeType: 'user', granteeId } })
    expect(granted.statusCode).toBe(200)
    const query = `/api/repositories/${repo!.id}/search?q=src%2Fstore.ts&route=path`
    expect((await app.inject({ method: 'GET', url: query, headers: { cookie } })).statusCode).toBe(200)
    const both = await searchNotes({ vaultIds: [], repositoryIds: [repoId, repo!.id] }, 'src/store.ts', 10, {}, { route: 'path' })
    expect(both).toMatchObject({ route: 'path', ambiguous: true })
    expect(new Set(both.results.map((r) => r.containerId)).size).toBe(2)
    expect((await app.inject({ method: 'DELETE', url: `/api/repositories/${repo!.id}/shares/${granted.json().id}`, headers: { cookie: foreignCookie } })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: query, headers: { cookie } })).statusCode).toBe(404)
    resetRateLimits()
    expect((await agent.callTool({ name: 'search', arguments: { repositoryId: repo!.id, query: 'src/store.ts', route: 'path' } })).isError).toBe(true)
  })
})

describe('limits of a routed answer (#1060 review)', () => {
  it('more than ten exact answers is not an answer: the hybrid path ranks them', async () => {
    const files = Array.from({ length: 12 }, (_, i) => ({ path: `pkg${String(i).padStart(2, '0')}/handler.ts`, content: `export function handler(): number {\n  return ${i}\n}\n` }))
    await syncRepositoryFiles(repoId, files, ['src/notes/frontmatter.ts', 'src/store.ts', 'src/a/parse.ts', 'src/b/parse.ts', 'docs/readme.md', ...files.map((f) => f.path)])
    await flushExtraction()
    const res = await ask('handler')
    expect(res).toMatchObject({ route: 'conceptual', attempted_route: 'identifier', retrieval_mode: 'fallback' })
    const files2 = await ask('handler.ts')
    expect(files2).toMatchObject({ route: 'conceptual', attempted_route: 'path', retrieval_mode: 'fallback' })
  })

  it('a routed answer carries the index block while something is still being indexed', async () => {
    await syncRepositoryFiles(repoId, [{ path: 'src/store.ts', content: 'export class Store {\n  save(item: string): string {\n    return item + "!"\n  }\n}\n' }], ['src/store.ts'])
    const res = await ask('src/store.ts')
    expect(res.route).toBe('path')
    expect(res.index?.pending_files).toBeGreaterThan(0)
    await flushExtraction()
    expect((await ask('src/store.ts')).index).toBeUndefined()
  })
})
