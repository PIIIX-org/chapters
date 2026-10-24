// ADR-004 wave 4a (#413, #452, #418, #460): a repository file's derived
// rows are blocks with a stable id. A symbol keeps its id (find_symbols `id`)
// when lines move above it or another symbol changes; a re-extraction embeds
// only the blocks whose text changed, reusing the rest; the whole block set
// of a file is replaced in one transaction, never partly, and a result for
// content that moved on is dropped. The stored text is the hashed text (NUL
// bytes stripped first), and a snippet is the exact text of its lines: CRLF
// and blank lines stay. The doctor reports a file without its blocks.
// Uses only entry points that existed before the blocks table (the
// fails-before job runs this file against the base source).
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { repositories, repositoryFiles } from '../src/db/schema.js'
import { FailpointError, setFailpointHandler, type Failpoint } from '../src/failpoints.js'
import { jobTiming } from '../src/jobs/durable.js'
import { runDoctor } from '../src/notes/doctor.js'
import { flushExtraction, scheduleExtraction } from '../src/repositories/extraction-queue.js'
import { listFileSymbols, syncRepositoryFiles } from '../src/repositories/store.js'
import { embedder } from '../src/search/embeddings.js'
import { findSymbols } from '../src/search/search.js'
import { createActiveUser } from './helpers.js'

const savedBackoff = jobTiming.backoffBaseMs
beforeEach(() => {
  jobTiming.backoffBaseMs = 0
})
afterEach(() => {
  jobTiming.backoffBaseMs = savedBackoff
  setFailpointHandler(null)
  vi.restoreAllMocks()
})

const PATH = 'src/blocks.ts'

async function makeRepo(name: string) {
  const owner = await createActiveUser()
  const [repo] = await db.insert(repositories).values({ name, ownerId: owner.id, ingestionMethod: 'agent_push' }).returning()
  return repo!
}

async function sync(repositoryId: string, content: string, path = PATH) {
  await syncRepositoryFiles(repositoryId, [{ path, content }], [path])
  await flushExtraction()
}

async function fileRow(repositoryId: string, path = PATH) {
  const [file] = await db
    .select()
    .from(repositoryFiles)
    .where(and(eq(repositoryFiles.repositoryId, repositoryId), eq(repositoryFiles.path, path)))
  return file!
}

async function symbolIds(repositoryId: string, names: string[]) {
  const ids: Record<string, string> = {}
  for (const name of names) {
    const [hit] = (await findSymbols([repositoryId], name, { limit: 1 })).results.filter((s) => s.name === name)
    if (hit) ids[name] = hit.id
  }
  return ids
}

/** Every text the embedder gets while `run` runs. */
async function embeddedDuring(run: () => Promise<void>): Promise<string[]> {
  const texts: string[] = []
  const embed = embedder.embed.bind(embedder)
  const spy = vi.spyOn(embedder, 'embed').mockImplementation(async (batch) => {
    texts.push(...batch)
    return embed(batch)
  })
  try {
    await run()
  } finally {
    spy.mockRestore()
  }
  return texts
}

const V1 = [
  'export function alpha() {',
  '  return 1',
  '}',
  '',
  'export function beta() {',
  '  return 2',
  '}',
  '',
  'export function gamma() {',
  '  return 3',
  '}',
  '',
].join('\n')

describe('a symbol block keeps its id (#413)', () => {
  it('lines inserted above every symbol: same ids, and only the file text is embedded again', async () => {
    const repo = await makeRepo('blocks-line-shift')
    await sync(repo.id, V1)
    const before = await symbolIds(repo.id, ['alpha', 'beta', 'gamma'])
    expect(Object.keys(before)).toEqual(['alpha', 'beta', 'gamma'])

    const shifted = `// a header comment\n// that moves every line down\n\n${V1}`
    const texts = await embeddedDuring(() => sync(repo.id, shifted))

    expect(await symbolIds(repo.id, ['alpha', 'beta', 'gamma'])).toEqual(before)
    // The symbols' text did not change, so their vectors are kept: only the whole (small) file is embedded again.
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('a header comment')
    const outline = await listFileSymbols((await fileRow(repo.id)).id)
    expect(outline.map((s) => [s.name, s.startLine, s.endLine])).toEqual([
      ['alpha', 4, 6],
      ['beta', 8, 10],
      ['gamma', 12, 14],
    ])
  })

  it('another symbol edited: the untouched symbols keep their ids and vectors; the edited one is embedded again', async () => {
    const repo = await makeRepo('blocks-edit-elsewhere')
    await sync(repo.id, V1)
    const before = await symbolIds(repo.id, ['alpha', 'beta', 'gamma'])

    const edited = V1.replace('  return 2', '  return 2 + 40')
    const texts = await embeddedDuring(() => sync(repo.id, edited))

    expect(await symbolIds(repo.id, ['alpha', 'beta', 'gamma'])).toEqual(before)
    expect(texts).toHaveLength(2)
    expect(texts.filter((t) => t.includes('return 2 + 40'))).toHaveLength(2) // the file and beta
    expect(texts.some((t) => t.includes('alpha in') || t.includes('gamma in'))).toBe(false)
  })
})

describe('a file block set is replaced in one transaction (#460)', () => {
  const V2 = V1.replace('export function gamma() {\n  return 3\n}\n', 'export function delta() {\n  return 4\n}\n')

  it('a crash before the commit leaves the whole previous set: names, lines and ids', async () => {
    const repo = await makeRepo('blocks-crash-before-commit')
    await sync(repo.id, V1)
    const file = await fileRow(repo.id)
    const outline = await listFileSymbols(file.id)
    const ids = await symbolIds(repo.id, ['alpha', 'beta', 'gamma'])

    vi.spyOn(console, 'error').mockImplementation(() => {})
    setFailpointHandler((name) => {
      if (name === 'extract.before-commit') throw new FailpointError(name as Failpoint)
    })
    await sync(repo.id, V2)
    setFailpointHandler(null)

    expect(await listFileSymbols(file.id)).toEqual(outline)
    expect(await symbolIds(repo.id, ['alpha', 'beta', 'gamma', 'delta'])).toEqual(ids)
  })

  it('without a crash the new set replaces it: a removed symbol is gone, the kept ones keep their ids', async () => {
    const repo = await makeRepo('blocks-replace')
    await sync(repo.id, V1)
    const ids = await symbolIds(repo.id, ['alpha', 'beta', 'gamma'])
    await sync(repo.id, V2)
    const after = await symbolIds(repo.id, ['alpha', 'beta', 'gamma', 'delta'])
    expect(after.alpha).toBe(ids.alpha)
    expect(after.beta).toBe(ids.beta)
    expect(after.gamma).toBeUndefined()
    expect(after.delta).toBeDefined()
    expect((await listFileSymbols((await fileRow(repo.id)).id)).map((s) => s.name)).toEqual(['alpha', 'beta', 'delta'])
  })

  it('a result for content that moved on during the embed is skipped; the newer content is written by its own job', async () => {
    const repo = await makeRepo('blocks-stale-version')
    const embed = embedder.embed.bind(embedder)
    vi.spyOn(embedder, 'embed').mockImplementation(async (texts) => {
      const vectors = await embed(texts)
      if (texts.some((t) => t.includes('gamma'))) {
        await db
          .update(repositoryFiles)
          .set({ content: V2, contentHash: createHash('sha256').update(V2).digest('hex'), size: V2.length })
          .where(and(eq(repositoryFiles.repositoryId, repo.id), eq(repositoryFiles.path, PATH)))
      }
      return vectors
    })
    await sync(repo.id, V1)
    const file = await fileRow(repo.id)
    expect(await listFileSymbols(file.id)).toEqual([])

    vi.restoreAllMocks()
    scheduleExtraction(file.id)
    await flushExtraction()
    expect((await listFileSymbols(file.id)).map((s) => s.name)).toEqual(['alpha', 'beta', 'delta'])
  })
})

describe('stored text = hashed text (#418)', () => {
  it('content_hash is the hash of the stored content, NUL bytes stripped', async () => {
    const repo = await makeRepo('blocks-nul-hash')
    const raw = 'export const a = 1\0\nexport const b = 2\n'
    await syncRepositoryFiles(repo.id, [{ path: 'src/nul.ts', content: raw }], ['src/nul.ts'])
    const file = await fileRow(repo.id, 'src/nul.ts')
    expect(file.content).toBe(raw.replace(/\0/g, ''))
    expect(file.contentHash).toBe(createHash('sha256').update(file.content).digest('hex'))
    // The same bytes again are unchanged; the stripped text is the same content too.
    const again = await syncRepositoryFiles(repo.id, [{ path: 'src/nul.ts', content: raw }], ['src/nul.ts'])
    expect(again.unchanged).toBe(1)
    const stripped = await syncRepositoryFiles(repo.id, [{ path: 'src/nul.ts', content: file.content }], ['src/nul.ts'])
    expect(stripped.unchanged).toBe(1)
    await flushExtraction()
  })

  it('a symbol snippet is the exact text of its lines: CRLF and blank lines kept', async () => {
    const repo = await makeRepo('blocks-crlf')
    const lines = ['export function spaced() {', '  const a = 1', '', '', '  return a', '}', '', 'export const tail = 2', '']
    const content = lines.join('\r\n')
    await sync(repo.id, content, 'src/crlf.ts')
    const [hit] = (await findSymbols([repo.id], 'spaced', { limit: 5 })).results.filter((s) => s.name === 'spaced')
    expect(hit).toMatchObject({ startLine: 1, endLine: 6 })
    expect(hit!.snippet).toBe(content.split('\n').slice(0, 6).join('\n'))
    expect(hit!.snippet).toBe('export function spaced() {\r\n  const a = 1\r\n\r\n\r\n  return a\r\n}\r')
    expect(content.includes(hit!.snippet!)).toBe(true)
  })
})

describe('the doctor checks repository files have their blocks (#413)', () => {
  it('a file with no blocks of its content is blocks-missing; --repair queues its extraction, which clears it', async () => {
    const repo = await makeRepo('blocks-doctor')
    const content = 'export function lost() { return 1 }\n'
    // Stored by a sync whose process stopped before it enqueued the extraction.
    await db.insert(repositoryFiles).values({
      repositoryId: repo.id,
      path: 'src/lost.ts',
      language: 'typescript',
      content,
      contentHash: createHash('sha256').update(content).digest('hex'),
      size: content.length,
    })
    const report = await runDoctor({ repositoryId: repo.id, repair: true })
    const problems = report.problems.filter((p) => p.path === 'src/lost.ts')
    expect(problems.map((p) => [p.class, p.repositoryId, p.repairable, p.repaired])).toEqual([['blocks-missing', repo.id, true, true]])

    // The server's worker polls for the job; here it is woken (the job the repair queued is the one it runs).
    const file = await fileRow(repo.id, 'src/lost.ts')
    scheduleExtraction(file.id)
    await flushExtraction()
    const after = await runDoctor({ repositoryId: repo.id })
    expect(after.problems.filter((p) => p.path === 'src/lost.ts')).toEqual([])
    expect((await listFileSymbols(file.id)).map((s) => s.name)).toEqual(['lost'])
  })
})
