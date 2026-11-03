// #684 part B: the same file content in a second repository of the same account reuses the vectors of the
// first instead of embedding again (blocks and edges stay per-repository rows). Another account's content is
// never looked at: a vector is a function of model and text, but the lookup is kept inside one account. The
// embedded text includes the path (`embedText`), so the same content at another path embeds again: sharing is for
// clones and forks, not moved files.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { blocks, repositories, repositoryFiles } from '../src/db/schema.js'
import { flushExtraction, scheduleMissingExtractions } from '../src/repositories/extraction-queue.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushEmbeddings, scheduleMissingEmbeddings } from '../src/search/embedding-queue.js'
import { embedder } from '../src/search/embeddings.js'
import type * as Extraction from '../src/repositories/extraction.js'
import { createActiveUser } from './helpers.js'

// The parses that run: every call of extractStructure, by file path (an existing export, so this counts on dev too).
const parses = vi.hoisted(() => [] as string[])
vi.mock('../src/repositories/extraction.js', async (importOriginal) => {
  const real = await importOriginal<typeof Extraction>()
  return {
    ...real,
    extractStructure: (language: string, content: string, path: string) => {
      parses.push(path)
      return real.extractStructure(language, content, path)
    },
  }
})

const createdRepositoryIds: string[] = []
beforeAll(async () => {
  await scheduleMissingEmbeddings()
  await scheduleMissingExtractions()
  await flushEmbeddings()
  await flushExtraction()
}, 600_000)
afterEach(async () => {
  vi.restoreAllMocks()
  for (const id of createdRepositoryIds.splice(0)) await db.delete(repositories).where(eq(repositories.id, id))
})

async function embeddedDuring(run: () => Promise<unknown>): Promise<string[]> {
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

const SHARED = (n: number) => ['export function shared' + n + '(a: number) {', '  return a + ' + n, '}', ''].join('\n')
const FILES = Array.from({ length: 5 }, (_, i) => ({ path: `src/shared${i}.ts`, content: SHARED(i) }))

async function newRepo(ownerId: string, name: string): Promise<string> {
  const [repo] = await db.insert(repositories).values({ name, ownerId, ingestionMethod: 'agent_push' }).returning()
  createdRepositoryIds.push(repo!.id)
  return repo!.id
}

async function sync(repositoryId: string, files: Array<{ path: string; content: string }>): Promise<string[]> {
  return embeddedDuring(async () => {
    await syncRepositoryFiles(repositoryId, files, files.map((f) => f.path))
    await flushExtraction()
  })
}

/** path -> sorted [embed_key, vector text] of the file's blocks. */
async function vectors(repositoryId: string): Promise<Record<string, Array<[string | null, string | null]>>> {
  const rows = await db
    .select({ path: repositoryFiles.path, embedKey: blocks.embedKey, embedding: blocks.embedding })
    .from(blocks)
    .innerJoin(repositoryFiles, and(eq(repositoryFiles.id, blocks.ownerId), eq(blocks.ownerType, 'code')))
    .where(eq(repositoryFiles.repositoryId, repositoryId))
  const out: Record<string, Array<[string | null, string | null]>> = {}
  for (const r of rows) (out[r.path] ??= []).push([r.embedKey, r.embedding ? JSON.stringify(r.embedding) : null])
  for (const list of Object.values(out)) list.sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  return out
}

describe('vectors are shared by embed key between the repositories of one account (#684)', () => {
  it('a second repository of the account with the same files embeds nothing and stores the same vectors', async () => {
    const owner = await createActiveUser()
    const a = await newRepo(owner.id, 'blob-a')
    const first = await sync(a, FILES)
    expect(first.length).toBeGreaterThanOrEqual(FILES.length)

    const b = await newRepo(owner.id, 'blob-b')
    parses.length = 0
    const second = await sync(b, FILES)
    expect(second).toEqual([])
    // Equal contents are parsed once per process, whichever repository holds them.
    expect(parses).toEqual([])
    expect(await vectors(b)).toEqual(await vectors(a))
  })

  it('a changed file in the second repository embeds only its own new texts', async () => {
    const owner = await createActiveUser()
    const a = await newRepo(owner.id, 'blob-edit-a')
    await sync(a, FILES)
    const b = await newRepo(owner.id, 'blob-edit-b')
    const edited = FILES.map((f, i) => (i === 2 ? { ...f, content: SHARED(99).replace('shared99', 'shared2') } : f))
    const texts = await sync(b, edited)
    expect(texts.length).toBeGreaterThan(0)
    expect(texts.every((t) => t.includes('src/shared2.ts'))).toBe(true)
  })

  it('another account embeds the same files itself', async () => {
    const a = await newRepo((await createActiveUser()).id, 'blob-own-a')
    const first = await sync(a, FILES)
    const b = await newRepo((await createActiveUser()).id, 'blob-own-b')
    const second = await sync(b, FILES)
    expect([...second].sort()).toEqual([...first].sort())
  })
})
