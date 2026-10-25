// #455: the keyword channel knows identifiers. A code file and a symbol are
// found by the parts of a camelCase, PascalCase, snake_case or dotted name
// (in any order), by the whole identifier inside a member access, and by a
// dotted path; within a keyword leg the exact whole identifier ranks before
// a match on its parts alone. Prose keeps its stemming. Every check runs on
// the keyword channel alone: the query embedding fails, so search answers
// `keyword_only` and the order of each resource type is its keyword leg's.
// Uses only entry points that exist on the base (the fails-before job runs
// this file against it).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { db } from '../src/db/client.js'
import { repositories, vaults } from '../src/db/schema.js'
import { createNote } from '../src/notes/store.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
import { embedder } from '../src/search/embeddings.js'
import { findSymbols, searchNotes } from '../src/search/search.js'
import { createActiveUser } from './helpers.js'

const FILES = [
  { path: 'src/notes/frontmatter.ts', content: 'export function parseFrontmatter(text: string): string {\n  return text.trim()\n}\n' },
  { path: 'py/notes_io.py', content: 'def parse_frontmatter(text):\n    return text.strip()\n' },
  { path: 'src/mcp/server.ts', content: "export const UUID_ARG = 'uuid'\n\nexport function startServer(): void {}\n" },
  { path: 'src/load.ts', content: 'export function load(fm: Reader): string {\n  return fm.parseFrontmatter(read())\n}\n' },
  { path: 'docs/reading.md', content: '# Reading a note\n\nWe parse the frontmatter first, then the body. Indexing runs nightly.\n' },
]

let repo: string
let vault: string

beforeAll(async () => {
  const owner = await createActiveUser()
  const [r] = await db.insert(repositories).values({ name: 'identifiers', ownerId: owner.id, ingestionMethod: 'agent_push' }).returning()
  repo = r!.id
  await syncRepositoryFiles(repo, FILES, FILES.map((f) => f.path))
  await flushExtraction()
  const [v] = await db.insert(vaults).values({ name: 'identifiers', ownerId: owner.id }).returning()
  vault = v!.id
  await createNote(vault, { path: 'ops/scheduler', frontmatter: {}, body: 'The scheduler runs every job nightly.\n' })
  await flushEmbeddings()
}, 120_000)

afterEach(() => {
  vi.restoreAllMocks()
})

/** The keyword channel alone: the query embedding fails, so no vector leg runs (#458). */
function keywordOnly() {
  vi.spyOn(embedder, 'embed').mockRejectedValue(new Error('embedder down'))
}

async function symbols(query: string): Promise<string[]> {
  keywordOnly()
  const answer = await findSymbols([repo], query)
  expect(answer.retrieval_mode).toBe('keyword_only')
  return answer.results.map((s) => `${s.path}#${s.name}`)
}

async function search(query: string, type: 'code' | 'symbol' | 'note'): Promise<string[]> {
  keywordOnly()
  const answer = await searchNotes({ vaultIds: [vault], repositoryIds: [repo] }, query, 20, {}, { includeSymbols: true })
  expect(answer.retrieval_mode).toBe('keyword_only')
  return answer.results.filter((r) => r.resourceType === type).map((r) => (type === 'symbol' ? `${r.path}#${r.symbolName}` : r.path))
}

describe('find_symbols by identifier parts (#455)', () => {
  it('camelCase parts in any order', async () => {
    expect(await symbols('frontmatter parse')).toContain('src/notes/frontmatter.ts#parseFrontmatter')
  })

  it('snake_case and camelCase spellings of the same name', async () => {
    expect(await symbols('parseFrontmatter')).toContain('py/notes_io.py#parse_frontmatter')
    expect(await symbols('frontmatter parse')).toContain('py/notes_io.py#parse_frontmatter')
  })

  it('a SCREAMING_SNAKE constant by its words', async () => {
    expect(await symbols('uuid arg')).toEqual(['src/mcp/server.ts#UUID_ARG'])
  })

  it('a dotted module path', async () => {
    expect(await symbols('notes_io.parse_frontmatter')).toEqual(['py/notes_io.py#parse_frontmatter'])
  })

  it('the exact identifier ranks before a match on its parts alone', async () => {
    expect(await symbols('parse_frontmatter')).toEqual(['py/notes_io.py#parse_frontmatter', 'src/notes/frontmatter.ts#parseFrontmatter'])
    // `load` calls `fm.parseFrontmatter`: its snippet holds the query, which ranked it before (contains).
    expect(await symbols('parseFrontmatter')).toEqual(['src/notes/frontmatter.ts#parseFrontmatter', 'src/load.ts#load', 'py/notes_io.py#parse_frontmatter'])
  })
})

describe('search by identifier (#455)', () => {
  it('finds a symbol by camelCase parts', async () => {
    expect(await search('frontmatter parse', 'symbol')).toContain('src/notes/frontmatter.ts#parseFrontmatter')
  })

  it('finds a member-access call site by the whole identifier', async () => {
    expect(await search('parseFrontmatter', 'code')).toContain('src/load.ts')
  })

  it('finds a file by a dotted path and by its file name', async () => {
    expect(await search('mcp.server.ts', 'code')).toEqual(['src/mcp/server.ts'])
    expect(await search('server.ts', 'code')).toEqual(['src/mcp/server.ts'])
  })

  it('finds code by the words of a snake_case constant', async () => {
    expect(await search('uuid arg', 'code')).toEqual(['src/mcp/server.ts'])
  })

  it('ranks the exact identifier before a match on its parts alone', async () => {
    // The first two hold `parseFrontmatter`; the others only its parts (`parse_frontmatter`, "parse the frontmatter").
    const code = await search('parseFrontmatter', 'code')
    expect(code.slice(0, 2)).toEqual(['src/notes/frontmatter.ts', 'src/load.ts'])
    expect(code.slice(2).sort()).toEqual(['docs/reading.md', 'py/notes_io.py'])
  })
})

describe('prose keeps its stemming (#455)', () => {
  it('a note and a Markdown file match inflected words', async () => {
    expect(await search('running jobs', 'note')).toEqual(['ops/scheduler'])
    expect(await search('index running', 'code')).toEqual(['docs/reading.md'])
  })
})
