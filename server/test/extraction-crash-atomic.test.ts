// #453: re-extracting a file must never leave it with fewer derived rows than
// before. The embed takes seconds; a crash or a failure during it, or between
// it and the write, must leave the previous imports, symbols and file vector
// in place (searchable) until a run finishes, never an empty window. A result
// computed from content that changed meanwhile (a newer file content, a newer
// note `seq`) is dropped, never written over the newer row. Job keys carry
// the versions that derive the result.
// Uses only entry points that existed before #453 (the fails-before job runs
// this file against the base source).
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { jobs, notes, repositories, repositoryFileImports, repositoryFiles, vaults } from '../src/db/schema.js'
import { FailpointError, setFailpointHandler, type Failpoint } from '../src/failpoints.js'
import { jobTiming } from '../src/jobs/durable.js'
import { flushExtraction, scheduleExtraction } from '../src/repositories/extraction-queue.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushEmbeddings, scheduleEmbedding } from '../src/search/embedding-queue.js'
import { embedder } from '../src/search/embeddings.js'
import { createActiveUser, fileEmbedding, noteVectors, symbolBlocks } from './helpers.js'

const savedBackoff = jobTiming.backoffBaseMs
beforeEach(() => {
  // Retries become claimable at once, so one flush runs every attempt.
  jobTiming.backoffBaseMs = 0
})
afterEach(() => {
  jobTiming.backoffBaseMs = savedBackoff
  setFailpointHandler(null)
  vi.restoreAllMocks()
})

const PATH = 'src/a.ts'
const V1 = "import { b } from './b'\nexport function oldName() { return b() }\n"
const V2 = "import { c } from './c'\nexport function newName() { return c() }\n"

async function derived(repositoryId: string) {
  const [file] = await db
    .select()
    .from(repositoryFiles)
    .where(and(eq(repositoryFiles.repositoryId, repositoryId), eq(repositoryFiles.path, PATH)))
  const symbols = await symbolBlocks(file!.id)
  const imports = await db.select().from(repositoryFileImports).where(eq(repositoryFileImports.sourceFileId, file!.id))
  return {
    embedding: await fileEmbedding(file!.id),
    symbols: symbols.map((s) => s.name),
    imports: imports.map((i) => i.targetPath),
  }
}

/** A file extracted at V1, then synced at V2 while `crash` makes every V2 run fail. */
async function reextractWith(name: string, crash: () => void) {
  const owner = await createActiveUser()
  const [repo] = await db
    .insert(repositories)
    .values({ name, ownerId: owner.id, ingestionMethod: 'agent_push' })
    .returning()
  await syncRepositoryFiles(repo!.id, [{ path: PATH, content: V1 }], [PATH])
  await flushExtraction()
  const before = await derived(repo!.id)
  expect(before.symbols).toEqual(['oldName'])
  expect(before.imports).toEqual(['./b'])
  expect(before.embedding).not.toBeNull()

  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  crash()
  await syncRepositoryFiles(repo!.id, [{ path: PATH, content: V2 }], [PATH])
  await flushExtraction()
  return { before, after: await derived(repo!.id) }
}

function crashAt(point: string) {
  return () =>
    setFailpointHandler((name) => {
      if (name === point) throw new FailpointError(name as Failpoint)
    })
}

describe('re-extraction keeps the previous derived rows until it commits (#453)', () => {
  it('the embed fails: the previous symbols, imports and vector stay', async () => {
    const { before, after } = await reextractWith('crash-embed', () => {
      const embed = embedder.embed.bind(embedder)
      vi.spyOn(embedder, 'embed').mockImplementation(async (texts) => {
        if (texts[0]!.startsWith(`${PATH}\nimport { c }`)) throw new Error('Synthetic embedder crash')
        return embed(texts)
      })
    })
    expect(after).toEqual(before)
  })

  it('a crash between the embed and the write: the previous rows stay', async () => {
    const { before, after } = await reextractWith('crash-after-embed', crashAt('extract.after-embed-before-write'))
    expect(after).toEqual(before)
  })

  it('a crash inside the write, before it commits: nothing of it is visible', async () => {
    const { before, after } = await reextractWith('crash-before-commit', crashAt('extract.before-commit'))
    expect(after).toEqual(before)
  })

  it('without a crash the new content replaces them', async () => {
    const { after } = await reextractWith('no-crash', () => {})
    expect(after.symbols).toEqual(['newName'])
    expect(after.imports).toEqual(['./c'])
  })
})

describe('a result for content that changed meanwhile is dropped (#453)', () => {
  it('extraction: a push during the embed keeps the old result off the new content; the newer job writes', async () => {
    const owner = await createActiveUser()
    const [repo] = await db
      .insert(repositories)
      .values({ name: 'stale-hash', ownerId: owner.id, ingestionMethod: 'agent_push' })
      .returning()
    const v2Hash = createHash('sha256').update(V2).digest('hex')
    const embed = embedder.embed.bind(embedder)
    vi.spyOn(embedder, 'embed').mockImplementation(async (texts) => {
      const vectors = await embed(texts)
      // V2 lands while V1 is being embedded (its own job is enqueued below).
      if (texts[0] === `${PATH}\n${V1}`) {
        await db
          .update(repositoryFiles)
          .set({ content: V2, contentHash: v2Hash, size: V2.length })
          .where(and(eq(repositoryFiles.repositoryId, repo!.id), eq(repositoryFiles.path, PATH)))
      }
      return vectors
    })
    await syncRepositoryFiles(repo!.id, [{ path: PATH, content: V1 }], [PATH])
    await flushExtraction()

    const stale = await derived(repo!.id)
    expect(stale).toEqual({ embedding: null, symbols: [], imports: [] })

    const [file] = await db
      .select()
      .from(repositoryFiles)
      .where(and(eq(repositoryFiles.repositoryId, repo!.id), eq(repositoryFiles.path, PATH)))
    scheduleExtraction(file!.id)
    await flushExtraction()
    const after = await derived(repo!.id)
    expect(after.symbols).toEqual(['newName'])
    expect(after.imports).toEqual(['./c'])
  })

  it('embedding: an edit during the embed keeps the old vector off the new seq; the newer job writes', async () => {
    const user = await createActiveUser()
    const [vault] = await db.insert(vaults).values({ name: 'stale-seq-vault', ownerId: user.id }).returning()
    try {
      const path = `stale-seq-${Date.now()}.md`
      const [note] = await db
        .insert(notes)
        .values({ vaultId: vault!.id, type: 'note', name: 'n', path, body: 'version one', frontmatter: {} })
        .returning()
      const embed = embedder.embed.bind(embedder)
      vi.spyOn(embedder, 'embed').mockImplementation(async (texts) => {
        const vectors = await embed(texts)
        // The trigger moves `seq`; the store would queue that seq's job in the same write (enqueued below).
        if (texts[0] === `${path}\nversion one`) await db.update(notes).set({ body: 'version two' }).where(eq(notes.id, note!.id))
        return vectors
      })
      scheduleEmbedding(note!.id)
      await flushEmbeddings()
      expect(await noteVectors(note!.id)).toEqual([])

      scheduleEmbedding(note!.id)
      await flushEmbeddings()
      const after = await noteVectors(note!.id)
      const [expected] = await embed([`${path}\nversion two`])
      expect(after).toHaveLength(1)
      expect(Math.max(...after[0]!.map((v, i) => Math.abs(v - expected![i]!)))).toBeLessThan(1e-6)
    } finally {
      await db.delete(vaults).where(eq(vaults.id, vault!.id))
    }
  })
})

describe('job keys carry the versions that derive the result (#453)', () => {
  it('extract:<fileId>:<contentHash>:<extractor version>:<embedder id>, embed_note:<noteId>:<seq>:<embedder id>', async () => {
    const owner = await createActiveUser()
    const [repo] = await db
      .insert(repositories)
      .values({ name: 'versioned-keys', ownerId: owner.id, ingestionMethod: 'agent_push' })
      .returning()
    await syncRepositoryFiles(repo!.id, [{ path: PATH, content: V1 }], [PATH])
    await flushExtraction()
    const [file] = await db.select().from(repositoryFiles).where(eq(repositoryFiles.repositoryId, repo!.id))
    const [fileJob] = await db.select().from(jobs).where(sql`${jobs.payload}->>'fileId' = ${file!.id}`)
    expect(fileJob!.idempotencyKey).toMatch(new RegExp(`^extract:${file!.id}:${file!.contentHash}:[1-9][0-9]*:[^:]+$`))

    const user = await createActiveUser()
    const [vault] = await db.insert(vaults).values({ name: 'versioned-keys-vault', ownerId: user.id }).returning()
    try {
      const [note] = await db
        .insert(notes)
        .values({ vaultId: vault!.id, type: 'note', name: 'n', path: `keys-${Date.now()}.md`, body: 'keyed', frontmatter: {} })
        .returning()
      scheduleEmbedding(note!.id)
      await flushEmbeddings()
      const [noteJob] = await db.select().from(jobs).where(sql`${jobs.payload}->>'noteId' = ${note!.id}`)
      expect(noteJob!.idempotencyKey).toMatch(new RegExp(`^embed_note:${note!.id}:1:[^:]+$`))
    } finally {
      await db.delete(vaults).where(eq(vaults.id, vault!.id))
    }
  })
})
