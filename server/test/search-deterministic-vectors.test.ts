// #623 (ADR-004 §2.3 total order): hits that score the same come back in one
// order, path by code unit first, whatever order their rows were written in.
// Every cut is total, the vector legs' own `LIMIT` included, so the same
// content on two instances (where every id differs) makes the same cuts and
// gets the same RRF ranks.
// #462: every vector leg runs with a deliberate `hnsw.ef_search` and pgvector's
// iterative index scan, so a leg whose WHERE (scope, kind) keeps few of the
// nearest rows of the whole instance still gets its own rows when the planner
// serves it from the HNSW index (as it does on a big instance).
// #1035: a leg whose scope is small reads the scope's blocks instead of the
// HNSW index, so it has every one of the scope's rows that ranks in its cut,
// even those the index's graph or its scan budget never reaches.
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
    const symbolHits = fromA.filter((hit) => hit.startsWith('symbol:'))
    expect(symbolHits).toEqual(CODE_SORTED.slice(0, symbolHits.length).map((p) => `symbol:${p}`))
    expect(await mixed(b)).toEqual(fromA)
  }, 120_000)

  it('symbols of one file: every cut by start line, not by their ids (which differ on every instance)', async () => {
    // 36 case variants of one name in one file, one per line: each is an exact name match (one keyword
    // tier), and their symbol blocks are given one vector, so the vector leg's distances are equal too. Both
    // legs then cut 30 of 36 by their tie-break alone; only lines 1-30 in both legs give the first 20 hits
    // the scores 2/(61+i) in line order.
    const repo = await repositoryWith(['src/one.ts'], () => VARIANTS.map((name) => `export function ${name}() { return 0 }\n`).join(''))
    await db.execute(sql`
      UPDATE blocks b SET embedding = (SELECT embedding FROM blocks WHERE container_id = ${repo} AND kind = 'symbol' ORDER BY start_line LIMIT 1)
      WHERE b.container_id = ${repo} AND b.kind = 'symbol'`)
    const answer = await findSymbols([repo], 'tiebrk', { limit: 20 })
    expect(answer.retrieval_mode).toBe('hybrid')
    expect(answer.results.map((r) => r.startLine)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
  }, 120_000)

  it('a note and a code file at one path: by resource type, not by their ids', async () => {
    // Each is alone in its legs (rank 1 in its keyword and its vector leg), so both score 2/61. Pairs are
    // written until the note's id sorts first, so an id tie-break would put the note first.
    const owner = await createActiveUser()
    const path = 'docs/samepath'
    for (let attempt = 1; ; attempt++) {
      const [vault] = await db.insert(vaults).values({ name: 'same-path', ownerId: owner.id }).returning()
      const note = await createNote(vault!.id, { path, body: 'tiebreakerwidget\n' })
      await flushEmbeddings()
      const repo = await repositoryWith([path], () => 'tiebreakerwidget\n')
      const [file] = (await db.execute(sql`SELECT id FROM repository_files WHERE repository_id = ${repo}`)) as unknown as Array<{ id: string }>
      if (byCodeUnit(note.id, file!.id) > 0 && attempt < 30) continue
      const answer = await searchNotes({ vaultIds: [vault!.id], repositoryIds: [repo] }, 'tiebreakerwidget', 10)
      expect(answer.results.map((r) => [r.resourceType, r.path])).toEqual([
        ['code', path],
        ['note', path],
      ])
      expect(answer.results[0]!.score).toBe(answer.results[1]!.score)
      break
    }
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
 * instance big enough for the planner to choose it. `maxScanTuples` sets
 * `hnsw.max_scan_tuples`, the iterative scan's budget, so a small instance
 * runs out of it as a big one does.
 */
function planAsOnABigInstance(maxScanTuples?: number) {
  const transaction = db.transaction.bind(db)
  vi.spyOn(db, 'transaction').mockImplementation(((run: (tx: typeof db) => Promise<unknown>) =>
    transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('enable_seqscan', 'off', true), set_config('enable_bitmapscan', 'off', true), set_config('enable_sort', 'off', true)`,
      )
      if (maxScanTuples !== undefined) await tx.execute(sql`SELECT set_config('hnsw.max_scan_tuples', ${String(maxScanTuples)}, true)`)
      return run(tx as unknown as typeof db)
    })) as unknown as typeof db.transaction)
}

describe('a filtered vector leg is not starved by the rest of the instance (#462)', () => {
  it('a small repository inside a big instance keeps its vector hits', async () => {
    // 500 files of another repository (more than the leg's ef_search of 200) are all nearer the query than
    // the small repository's files, which share one word with it (distance 0.74, under the fake embedder's
    // gate of 0.8), so only the vector channel can find them. Through the HNSW index `small/a.md` was missing
    // in some builds (#1035: no node linked to it); a scope this small is now read exactly.
    const big = await repository('big')
    const files = Array.from({ length: 500 }, (_, i) => ({ path: `big/f${i}.md`, content: `starve query words w${i}\n` }))
    await syncRepositoryFiles(big, files, files.map((f) => f.path))
    const small = await repositoryWith(['small/a.md', 'small/c.md'], (path) => (path.endsWith('a.md') ? 'starve other\n' : 'starve thing\n'))

    planAsOnABigInstance()
    const answer = await searchNotes({ vaultIds: [], repositoryIds: [small] }, 'starve query words', 20)
    expect(answer.retrieval_mode).toBe('hybrid')
    expect(answer.results.map((r) => r.path)).toEqual(['small/a.md', 'small/c.md'])
  }, 120_000)
})

describe('a small scope is read exactly, not through the HNSW graph (#1035)', () => {
  it('a small vault the HNSW scan never reaches keeps its vector hits', async () => {
    // An HNSW scan reaches a row only along the graph's links. 600 note blocks of one vault are nearer the
    // query than any other block: they fill the scan's 200 candidates, and the scan expands nothing farther.
    // 80 blocks of a second vault are nearer the small vault's notes than those 600 are, so the small vault's
    // blocks, written last, link only to them. With `hnsw.max_scan_tuples` 1 the iterative scan stops there,
    // as its default 20,000 does on an instance with that many rows nearer the query: through the index the
    // leg answers [] in every build (40 of 40 bare-table builds). The small vault's notes share one word with
    // the query (distance 0.71, under the fake embedder's gate of 0.8), so only the vector channel finds them.
    const owner = await createActiveUser()
    const vaultWith = async (name: string, notes: Array<{ path: string; body: string }>) => {
      const [vault] = await db.insert(vaults).values({ name, ownerId: owner.id }).returning()
      for (const note of notes) await createNote(vault!.id, note)
      await flushEmbeddings()
      return vault!.id
    }
    const sections = (count: number, text: string) => Array.from({ length: count }, (_, i) => `## s${i}\n${text}\n`).join('')
    await vaultWith('near', Array.from({ length: 12 }, (_, n) => ({ path: `near/n${n}`, body: sections(50, 'starve query words') })))
    await vaultWith('far', Array.from({ length: 2 }, (_, n) => ({ path: `far/f${n}`, body: sections(40, 'starve other') })))
    const small = await vaultWith('small', [
      { path: 'small/a', body: 'starve other\n' },
      { path: 'small/c', body: 'starve other\n' },
    ])

    planAsOnABigInstance(1)
    const answer = await searchNotes({ vaultIds: [small], repositoryIds: [] }, 'starve query words', 20)
    expect(answer.retrieval_mode).toBe('hybrid')
    expect(answer.results.map((r) => r.path)).toEqual(['small/a', 'small/c'])
  }, 120_000)
})
