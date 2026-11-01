// #1060: an identifier or a path asked for by itself is answered by exact lookup: one answer with `confidence` 1,
// or all the exact answers with `ambiguous`, never a list of look-alikes. Any other query takes the hybrid path
// unchanged and its response names no route.
import { beforeAll, describe, expect, it } from 'vitest'
import { db } from '../src/db/client.js'
import { repositories, vaults } from '../src/db/schema.js'
import { createNote } from '../src/notes/store.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
import { routeTerm } from '../src/search/router.js'
import { searchNotes } from '../src/search/search.js'
import { createActiveUser } from './helpers.js'

let repoId: string
let vaultId: string
const code = { vaultIds: [] as string[], repositoryIds: [] as string[] }

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
    { path: 'src/a/parse.ts', content: 'export function parse(s: string): string {\n  return s\n}\n' },
    { path: 'src/b/parse.ts', content: 'export function parse(s: string): string {\n  return s.toLowerCase()\n}\n' },
    { path: 'docs/readme.md', content: '# Readme\n\nparseFrontmatter is described in the frontmatter module.\n' },
  ]
  await syncRepositoryFiles(repoId, files, files.map((f) => f.path))
  await createNote(vaultId, { path: 'docs/guide', body: '# Guide\n\nHow the parseFrontmatter helper is used.\n' })
  await flushExtraction()
  await flushEmbeddings()
}, 120_000)

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
    expect(routeTerm('ab')).toBeNull()
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

  it('several exact symbols are all listed, ambiguous, with no fuzzy hit added', async () => {
    const res = await ask('parse')
    expect(res).toMatchObject({ route: 'identifier', ambiguous: true, retrieval_mode: 'exact' })
    expect(res.confidence).toBeUndefined()
    expect(res.results.map((r) => r.path)).toEqual(['src/a/parse.ts', 'src/b/parse.ts'])
  })

  it('a name nothing is called, a long question and a query without symbols take the hybrid path and name no route', async () => {
    for (const res of [
      await ask('parseFrontmatterX'),
      await ask('how does the parser handle `parseFrontmatter` when the text has no fence'),
      await ask('parseFrontmatter', false),
    ]) {
      expect(res.route).toBeUndefined()
      expect(res.confidence).toBeUndefined()
      expect(res.retrieval_mode).toBe('hybrid')
      expect(Object.keys(res)).not.toContain('route')
    }
  })
})

describe('path route (#1060)', () => {
  it('a file path or a file name is that file, whole', async () => {
    const byPath = await ask('src/store.ts')
    expect(byPath).toMatchObject({ route: 'path', confidence: 1, retrieval_mode: 'exact' })
    expect(byPath.results).toHaveLength(1)
    expect(byPath.results[0]).toMatchObject({ resourceType: 'code', path: 'src/store.ts', startLine: 1, endLine: 5, channel: 'exact' })
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
  })
})
