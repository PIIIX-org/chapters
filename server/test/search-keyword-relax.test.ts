// #455 part 2: the keyword channel relaxes a query that matches too little,
// weights a file's path and symbol names and a note's title and path above
// its body, and falls back to trigram similarity on paths and symbol names
// for a term that matches nothing (a typo'd identifier). Relaxation is a
// ladder over those fields, not a blanket OR over bodies: the least selective
// terms are dropped first, the rarest one always matches, a file that holds
// the words only in its body is no relaxed match (the #1014 lesson), and every
// row that matches all the terms ranks above every relaxed row. Every check
// runs on the keyword channel alone: the query embedding fails, so search
// answers `keyword_only` and the order of each resource type is its keyword
// leg's. Uses only entry points that exist on the base (the fails-before job
// runs this file against it).
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
  // A question about this function holds words it does not (`file`, `line`).
  {
    path: 'src/ghidra/headless.ts',
    content: "export function buildAnalyzeHeadlessCommand(project: string): string[] {\n  return ['analyzeHeadless', project]\n}\n",
  },
  // Every word of that question but the identifier: a blanket OR would rank it first.
  { path: 'docs/install.md', content: '# Install\n\nInstall Ghidra first. Each file and function of the project builds from the command line.\n' },
  // `file` and `line` are common words, as in any repository.
  { path: 'docs/format.md', content: '# Format\n\nEach line of an export file is one record.\n' },
  // `queue retry timeout`: all three in one file; `queue` and `retry` in another's path; `timeout`, the least
  // selective term, in two more files without the other two.
  { path: 'docs/delivery.md', content: '# Delivery\n\nA failed delivery goes back on the queue for a retry after its timeout.\n' },
  { path: 'src/queue/retry.ts', content: 'export const attempts = 3\n' },
  { path: 'src/net/socket.ts', content: 'export const timeout = 30\n' },
  { path: 'src/net/http.ts', content: 'export const timeout = 60\n' },
  // `scheduler` in a path, and many times in a body.
  { path: 'src/cron/scheduler.ts', content: 'export const cron = 1\n' },
  { path: 'docs/cron.md', content: '# Cron\n\nThe scheduler wakes up every minute. The scheduler then runs each scheduler job.\n' },
  // A typo'd identifier's target.
  { path: 'src/notes/frontmatter.ts', content: 'export function parseFrontmatter(text: string): string {\n  return text.trim()\n}\n' },
]

let repo: string
let vault: string

beforeAll(async () => {
  const owner = await createActiveUser()
  const [r] = await db.insert(repositories).values({ name: 'keyword-relax', ownerId: owner.id, ingestionMethod: 'agent_push' }).returning()
  repo = r!.id
  await syncRepositoryFiles(repo, FILES, FILES.map((f) => f.path))
  await flushExtraction()
  const [v] = await db.insert(vaults).values({ name: 'keyword-relax', ownerId: owner.id }).returning()
  vault = v!.id
  await createNote(vault, { path: 'ops/backups', frontmatter: {}, body: 'Backups run nightly at two and are kept for a week.\n' })
  await createNote(vault, { path: 'ops/rota', frontmatter: { title: 'Scheduler' }, body: 'Who is on call this week.\n' })
  await createNote(vault, { path: 'ops/jobs', frontmatter: {}, body: 'The scheduler starts each job. The scheduler retries a failed job, and the scheduler logs it.\n' })
  await flushEmbeddings()
}, 120_000)

afterEach(() => {
  vi.restoreAllMocks()
})

/** The keyword channel alone: the query embedding fails, so no vector leg runs (#458). */
function keywordOnly() {
  vi.spyOn(embedder, 'embed').mockRejectedValue(new Error('embedder down'))
}

async function search(query: string, type: 'code' | 'symbol' | 'note'): Promise<string[]> {
  keywordOnly()
  const answer = await searchNotes({ vaultIds: [vault], repositoryIds: [repo] }, query, 20, {}, { includeSymbols: true })
  expect(answer.retrieval_mode).toBe('keyword_only')
  return answer.results.filter((r) => r.resourceType === type).map((r) => (type === 'symbol' ? `${r.path}#${r.symbolName}` : r.path))
}

async function symbols(query: string): Promise<string[]> {
  keywordOnly()
  const answer = await findSymbols([repo], query)
  expect(answer.retrieval_mode).toBe('keyword_only')
  return answer.results.map((s) => `${s.path}#${s.name}`)
}

describe('relaxation (#455)', () => {
  const QUESTION = 'Which file and function build the Ghidra analyzeHeadless command line for a project?'

  it('a question whose words no file holds all of finds its file by the words of its path and names', async () => {
    // No file has every word, so the AND query matches nothing. `src/ghidra/headless.ts` has `ghidra` in its path
    // and `build` and `command` in a name it declares. `docs/install.md` has every word but the identifier, in its
    // body only: a blanket OR would rank it first, the ladder over fields does not match it.
    expect(await search(QUESTION, 'code')).toEqual(['src/ghidra/headless.ts'])
    expect(await search(QUESTION, 'symbol')).toEqual(['src/ghidra/headless.ts#buildAnalyzeHeadlessCommand'])
  })

  it('a note question, by the words of its path', async () => {
    expect(await search('When do the nightly backups run, and who checks them?', 'note')).toEqual(['ops/backups'])
  })

  it('every row that matches all the terms ranks above every relaxed row', async () => {
    // `docs/delivery.md` has all three in its body; `src/queue/retry.ts` has the two rarer ones in its path, which
    // would rank it first among equals; `timeout`, the name of two other files' constants, is dropped first, so
    // those files do not match.
    expect(await search('queue retry timeout', 'code')).toEqual(['docs/delivery.md', 'src/queue/retry.ts'])
  })
})

describe('field weights (#455)', () => {
  it("a term in a file's path ranks above the same term in a body", async () => {
    expect(await search('scheduler', 'code')).toEqual(['src/cron/scheduler.ts', 'docs/cron.md'])
  })

  it("a term in a note's title ranks above the same term in a body", async () => {
    expect(await search('scheduler', 'note')).toEqual(['ops/rota', 'ops/jobs'])
  })
})

describe('trigram fallback (#455)', () => {
  it("a typo'd identifier finds the symbol and its file", async () => {
    expect(await symbols('parseFrontmater')).toEqual(['src/notes/frontmatter.ts#parseFrontmatter'])
    expect(await search('parseFrontmater', 'code')).toEqual(['src/notes/frontmatter.ts'])
  })
})
