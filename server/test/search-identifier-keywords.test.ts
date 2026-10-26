// #455: the keyword channel knows identifiers. A code file and a symbol are
// found by the parts of a camelCase, PascalCase, snake_case or dotted name
// (in any order), by the whole identifier inside a member access, and by a
// dotted path; within a keyword leg the exact whole identifier ranks before
// a match on its parts alone. In the code leg an identifier in the query
// matches its own spellings, not a file that only holds its words (the
// benchmark regression of #1014). Prose keeps its stemming. Every check runs on
// the keyword channel alone: the query embedding fails, so search answers
// `keyword_only` and the order of each resource type is its keyword leg's.
// Uses only entry points that exist on the base (the fails-before job runs
// this file against it).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
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
  { path: 'src/notes/reader.ts', content: "export class NoteReader {\n  loadBody(): string {\n    return ''\n  }\n}\n" },
  // A symbol named `server`, and symbols in files under `server/` (Python, so they hold no `ts` for `server.ts`).
  { path: 'py/app.py', content: 'def server():\n    return 1\n' },
  ...Array.from({ length: 5 }, (_, i) => ({ path: `server/handler${i}.py`, content: `def handle_${i}():\n    return ${i}\n` })),
  // A class, and a document holding every word of a question about it but not its name.
  {
    path: 'src/hopper/HopperRequestQueue.ts',
    content: "// One request to Hopper at a time; it handles a timeout and a caller's cancellation.\nexport class HopperRequestQueue {}\n",
  },
  { path: 'docs/hopper.md', content: '# Hopper\n\nEach request to Hopper waits in a queue, which handles a timeout and a caller cancellation.\n' },
  // `host/platform` as written, and its two words apart: one in a compound, one in the path.
  { path: 'src/detect.ts', content: "// Detects the host/platform in priority order.\nexport function detect(): string {\n  return 'env'\n}\n" },
  { path: 'docs/platform-support.md', content: '# Platforms\n\nHost-specific hooks are detected in priority order.\n' },
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

  it('a dotted name path', async () => {
    expect(await symbols('reader.load_body')).toEqual(['src/notes/reader.ts#loadBody'])
  })

  it('not by its file path: a name, not every symbol under a folder of that name', async () => {
    expect(await symbols('server')).toEqual(['py/app.py#server', 'src/mcp/server.ts#startServer'])
  })

  it('a query token too long for a tsquery word leaves the keyword leg answering', async () => {
    expect(await symbols('b'.repeat(2100))).toEqual([])
    // The over-long whole and part match nothing; the term still matches by its `parse` part.
    expect(await symbols(`parse${'X'.repeat(2100)}`)).toEqual(['py/notes_io.py#parse_frontmatter', 'src/notes/frontmatter.ts#parseFrontmatter'])
    expect(await search(`parse_${'x'.repeat(2100)} frontmatter`, 'code')).toBeInstanceOf(Array)
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

  it('finds a member-access call site by the whole identifier, with its first lines as the snippet', async () => {
    expect(await search('parseFrontmatter', 'code')).toContain('src/load.ts')
    // The English query matches nothing in it (`fm.parseFrontmatter` is one host lexeme), so no headline.
    keywordOnly()
    const { results } = await searchNotes({ vaultIds: [], repositoryIds: [repo] }, 'parseFrontmatter')
    expect(results.find((r) => r.path === 'src/load.ts')?.snippet).toBe(FILES[3]!.content.slice(0, 200))
  })

  it('finds a file by a dotted path and by its file name', async () => {
    expect(await search('mcp.server.ts', 'code')).toEqual(['src/mcp/server.ts'])
    expect(await search('server.ts', 'code')).toEqual(['src/mcp/server.ts'])
  })

  it('finds code by the words of a snake_case constant', async () => {
    expect(await search('uuid arg', 'code')).toEqual(['src/mcp/server.ts'])
  })

  it('ranks the exact identifier before its other spellings', async () => {
    // The first two hold `parseFrontmatter`, the third its snake_case spelling; "parse the frontmatter" in
    // `docs/reading.md` has only its words, which do not match a compound in the code leg.
    expect(await search('parseFrontmatter', 'code')).toEqual(['src/notes/frontmatter.ts', 'src/load.ts', 'py/notes_io.py'])
  })

  it('in a question, an identifier does not match a file that only holds its words (#1014 benchmark)', async () => {
    // `docs/hopper.md` has hopper, request and queue and every other word of the question, but not the name. As a
    // match of the code leg it got a keyword rank on top of its vector rank, and the fusion put it (and on the
    // benchmark's rea corpus, its long release notes and guides) above the file that defines the name.
    expect(await search('How does `HopperRequestQueue` handle a timeout and caller cancellation?', 'code')).toEqual([
      'src/hopper/HopperRequestQueue.ts',
    ])
    // Its words still find it.
    expect(await search('hopper request queue', 'code')).toContain('src/hopper/HopperRequestQueue.ts')
  })

  it('a term of words joined by a slash keeps its English reading in the code leg (#1014 benchmark)', async () => {
    // `host/platform` holds no identifier. Its words apart (`host` from `Host-specific`, `platform` from the path)
    // made `docs/platform-support.md` a match; on context-mode that moved the platform guide above the detector.
    expect(await search('Which host/platform is detected in priority order?', 'code')).toEqual(['src/detect.ts'])
  })
})

describe('prose keeps its stemming (#455)', () => {
  it('a note and a Markdown file match inflected words', async () => {
    expect(await search('running jobs', 'note')).toEqual(['ops/scheduler'])
    expect(await search('index running', 'code')).toEqual(['docs/reading.md'])
  })
})

describe('only symbol blocks hold identifier keywords (#455)', () => {
  it('a Markdown heading section (#464) gets none', async () => {
    const rows = (await db.execute(sql`SELECT b.kind, b.keywords IS NULL AS empty FROM blocks b JOIN repository_files f ON f.id = b.owner_id
      WHERE f.repository_id = ${repo} AND f.path = 'docs/reading.md' AND b.kind = 'section'`)) as unknown as Array<{ kind: string; empty: boolean }>
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.empty)).toBe(true)
  })
})

describe('a file changed since its extraction (#455)', () => {
  // Last: it rewrites a fixture file. A sync stores new content (its generated `fts` with it) before the file
  // is extracted again; until then the leg reads that `fts`, not the identifiers of the old content.
  it('matches its new content, not the identifiers of the old one', async () => {
    await db.execute(sql`UPDATE repository_files SET content = 'export const renamedLoader = 1\n', content_hash = 'changed'
      WHERE repository_id = ${repo} AND path = 'src/load.ts'`)
    expect(await search('parseFrontmatter', 'code')).not.toContain('src/load.ts')
    expect(await search('renamedLoader', 'code')).toEqual(['src/load.ts'])
  })
})
