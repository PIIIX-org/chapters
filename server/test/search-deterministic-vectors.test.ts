// #623 (ADR-004 §2.3 total order): hits that score the same come back in one
// order, path by code unit first, whatever order their rows were written in.
// Every cut is total, the vector legs' own `LIMIT` included, so the same
// content on two instances (where every id differs) makes the same cuts and
// gets the same RRF ranks.
// #462: every vector leg runs with a deliberate `hnsw.ef_search` and pgvector's
// iterative index scan, so a leg whose WHERE (scope, kind) keeps few of the
// nearest rows of the whole instance still gets its own rows when the planner
// serves it from the HNSW index (as it does on a big instance).
// Uses only entry points that exist on the base (the fails-before job runs
// this file against it).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { repositories, vaults } from '../src/db/schema.js'
import { createNote } from '../src/notes/store.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
import { findSymbols, searchNotes } from '../src/search/search.js'
import { createActiveUser } from './helpers.js'

afterEach(() => {
  vi.restoreAllMocks()
})

// 36 case variants of one word, more than a leg's 30-row cut. The test
// embedder lower-cases words and full-text search folds case, so every variant
// scores exactly the same in every leg; case also puts a locale collation's
// order (and so a path-ordered write) apart from code-unit order.
const VARIANTS = Array.from({ length: 36 }, (_, i) => [...'tiebrk'].map((c, bit) => ((i >> bit) & 1 ? c.toUpperCase() : c)).join(''))
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
/** Write orders that are neither sorted nor each other's mirror image. */
const writeOrders = (xs: string[]) => [xs.map((_, i) => xs[(i * 7) % xs.length]!), [...xs].sort(byCodeUnit).reverse()]

const CODE = 'export function tieBreakerWidget() { return 42 }\n'
const CODE_PATHS = VARIANTS.map((v) => `src/${v}.ts`)
const CODE_SORTED = [...CODE_PATHS].sort(byCodeUnit)

async function repository(name: string): Promise<string> {
  const owner = await createActiveUser()
  const [repo] = await db.insert(repositories).values({ name, ownerId: owner.id, ingestionMethod: 'agent_push' }).returning()
  return repo!.id
}

/** A repository whose files are written, and indexed, one at a time in `paths`' order. */
async function repositoryWith(paths: string[], content: (path: string) => string): Promise<string> {
  const id = await repository('tie-break')
  for (const [i, path] of paths.entries()) {
    await syncRepositoryFiles(id, [{ path, content: content(path) }], paths.slice(0, i + 1))
    await flushExtraction()
  }
  return id
}

describe('equal scores keep one order whatever the write order (#623)', () => {
  it('code files and symbols', async () => {
    const [orderA, orderB] = writeOrders(CODE_PATHS)
    const a = await repositoryWith(orderA!, () => CODE)
    const b = await repositoryWith(orderB!, () => CODE)
    const files = async (id: string) => (await searchNotes({ vaultIds: [], repositoryIds: [id] }, 'tieBreakerWidget', 20)).results.map((r) => r.path)
    expect(await files(a)).toEqual(CODE_SORTED.slice(0, 20))
    expect(await files(b)).toEqual(CODE_SORTED.slice(0, 20))

    const symbols = async (id: string) => (await findSymbols([id], 'tieBreakerWidget', { limit: 20 })).results.map((r) => r.path)
    expect(await symbols(a)).toEqual(CODE_SORTED.slice(0, 20))
    expect(await symbols(b)).toEqual(CODE_SORTED.slice(0, 20))

    const mixed = async (id: string) =>
      (await searchNotes({ vaultIds: [], repositoryIds: [id] }, 'tieBreakerWidget', 40, {}, { includeSymbols: true })).results.map(
        (r) => `${r.resourceType}:${r.path}`,
      )
    const fromA = await mixed(a)
    expect(fromA.filter((hit) => hit.startsWith('symbol:'))).toEqual(CODE_SORTED.slice(0, 30).map((p) => `symbol:${p}`).slice(0, fromA.length / 2))
    expect(await mixed(b)).toEqual(fromA)
  }, 120_000)

  it('notes', async () => {
    const owner = await createActiveUser()
    // 36 orders of the same five words (note paths are lower-case slugs): to the test embedder and to
    // full-text search a path is a bag of words, so every note scores exactly the same.
    const words = ['amber', 'birch', 'cedar', 'delta', 'ember']
    const paths = Array.from({ length: 36 }, (_, i) => {
      const left = [...words]
      return `docs/${[24, 6, 2, 1, 1].map((radix, k) => left.splice(Math.floor(i / radix) % (5 - k), 1)[0]).join('-')}`
    })
    const vaultWith = async (order: string[]) => {
      const [vault] = await db.insert(vaults).values({ name: 'tie-break', ownerId: owner.id }).returning()
      for (const path of order) await createNote(vault!.id, { path, body: 'identical tiebreakerwidget body\n' })
      await flushEmbeddings()
      return vault!.id
    }
    const [orderA, orderB] = writeOrders(paths)
    const a = await vaultWith(orderA!)
    const b = await vaultWith(orderB!)
    const run = async (id: string) => (await searchNotes({ vaultIds: [id], repositoryIds: [] }, 'tiebreakerwidget', 20)).results.map((r) => r.path)
    const sorted = [...paths].sort(byCodeUnit).slice(0, 20)
    expect(await run(a)).toEqual(sorted)
    expect(await run(b)).toEqual(sorted)
  }, 120_000)
})

/**
 * Runs every transaction with sequential scans, bitmap scans and explicit
 * sorts priced out, so a vector leg is served by its HNSW index as on an
 * instance big enough for the planner to choose it.
 */
function planAsOnABigInstance() {
  const transaction = db.transaction.bind(db)
  vi.spyOn(db, 'transaction').mockImplementation(((run: (tx: typeof db) => Promise<unknown>) =>
    transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('enable_seqscan', 'off', true), set_config('enable_bitmapscan', 'off', true), set_config('enable_sort', 'off', true)`,
      )
      return run(tx as unknown as typeof db)
    })) as unknown as typeof db.transaction)
}

describe('a filtered vector leg is not starved by the rest of the instance (#462)', () => {
  it('a small repository inside a big instance keeps its vector hits', async () => {
    // 250 files of another repository (more than the leg's ef_search of 200) are all nearer the query than
    // the small repository's files, which share one word with it, so only the vector channel can find them.
    const big = await repository('big')
    const files = Array.from({ length: 250 }, (_, i) => ({ path: `big/f${i}.md`, content: `starve query words w${i}\n` }))
    await syncRepositoryFiles(big, files, files.map((f) => f.path))
    const small = await repositoryWith(['small/a.md', 'small/b.md'], (path) => (path.endsWith('a.md') ? 'starve other\n' : 'starve thing\n'))

    planAsOnABigInstance()
    const answer = await searchNotes({ vaultIds: [], repositoryIds: [small] }, 'starve query words', 20)
    expect(answer.retrieval_mode).toBe('hybrid')
    expect(answer.results.map((r) => r.path)).toEqual(['small/a.md', 'small/b.md'])
  }, 120_000)
})
