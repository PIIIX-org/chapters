// #454: every search filter applies inside each leg's SQL, before the leg's
// cut, so a filtered query answers with the k best matching rows rather than
// the matching remains of the unfiltered top k. Each fixture puts the
// matching rows outside every leg's unfiltered cut: 250 noise notes or files
// (more than the vector leg's 200-block cut, and the keyword legs' 30) are
// nearer the query than the 5 targets, which share one word with it, so only
// the vector channel can find them, and only if the filter runs before the
// cut. Each check runs twice: with this small instance's own plan (exact: a
// sequential scan and a sort, so the base's cut deterministically drops the
// targets) and as on a big instance (on the base, served by the HNSW index
// with the iterative scan of #462, approximate; since #1035 a scope of at
// most 2,000 blocks, as each one here, is read exactly in both).
// Uses only entry points that exist on the base (the fails-before job runs
// this file against it); filters the base lacks are ignored there.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { repositories, vaults } from '../src/db/schema.js'
import { createNote } from '../src/notes/store.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
import { findSymbols, searchNotes } from '../src/search/search.js'
import { createActiveUser, loginCookie } from './helpers.js'

afterEach(() => {
  vi.restoreAllMocks()
})

/** Every transaction with sequential scans, bitmap scans and sorts priced out: vector legs use their HNSW index. */
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

/** `run()` answers `expected` with the planner's own plan and as on a big instance. */
async function inBothPlans(run: () => Promise<string[]>, expected: string[]): Promise<void> {
  expect(await run()).toEqual(expected)
  planAsOnABigInstance()
  try {
    expect(await run()).toEqual(expected)
  } finally {
    vi.restoreAllMocks()
  }
}

const QUERY = 'starve query'
const NOISE = 250
const TARGETS = Array.from({ length: 5 }, (_, i) => i)
// Filters the base's `GraphFilters` lacks: passed through as the new code takes them.
type Filters = Parameters<typeof searchNotes>[3] & { languages?: string[]; kinds?: string[]; path?: string }
const search = (resources: Parameters<typeof searchNotes>[0], filters: Filters, includeSymbols = false) =>
  searchNotes(resources, QUERY, TARGETS.length, filters, { includeSymbols })
const paths = async (answer: ReturnType<typeof searchNotes>) => (await answer).results.map((r) => r.path)

describe('note filters apply inside each leg (#454)', () => {
  let vault: string
  const notes = (filters: Filters) => search({ vaultIds: [vault], repositoryIds: [] }, filters)
  const targetPaths = TARGETS.map((i) => `target/t${i}`)

  beforeAll(async () => {
    const owner = await createActiveUser()
    const [row] = await db.insert(vaults).values({ name: 'filters', ownerId: owner.id }).returning()
    vault = row!.id
    for (let i = 0; i < NOISE; i++) {
      await createNote(vault, { path: `noise/n${i}`, frontmatter: { tags: ['noise'] }, body: 'starve query\n' })
    }
    for (const i of TARGETS) await createNote(vault, { path: `target/t${i}`, frontmatter: { tags: ['target'] }, body: 'starve\n' })
    await flushEmbeddings()
  }, 300_000)

  it('the unfiltered top k holds no target', async () => {
    const answer = await notes({})
    expect(answer.results).toHaveLength(TARGETS.length)
    expect(answer.results.filter((r) => r.path.startsWith('target/'))).toEqual([])
  })

  it('types', async () => {
    await inBothPlans(() => paths(notes({ types: ['target'] })), targetPaths)
  })

  it('tags', async () => {
    await inBothPlans(() => paths(notes({ tags: ['target'] })), targetPaths)
  })

  it('since and until', async () => {
    await db.execute(sql`UPDATE notes SET updated_at = CASE WHEN path LIKE 'target/%' THEN '2021-06-01'::timestamptz ELSE '2024-06-01'::timestamptz END WHERE vault_id = ${vault}`)
    await inBothPlans(() => paths(notes({ until: '2022-01-01' })), targetPaths)
    await db.execute(sql`UPDATE notes SET updated_at = CASE WHEN path LIKE 'target/%' THEN '2024-06-01'::timestamptz ELSE '2021-06-01'::timestamptz END WHERE vault_id = ${vault}`)
    await inBothPlans(() => paths(notes({ since: '2022-01-01' })), targetPaths)
  })

  it('path prefix and glob', async () => {
    await inBothPlans(() => paths(notes({ path: 'target/' })), targetPaths)
    await inBothPlans(() => paths(notes({ path: 'target/t*' })), targetPaths)
    await inBothPlans(() => paths(notes({ path: '*/t?' })), targetPaths)
  })
})

describe('code and symbol filters apply inside each leg (#454)', () => {
  let repo: string
  let ownerEmail: string
  const code = (filters: Filters, includeSymbols = false) => search({ vaultIds: [], repositoryIds: [repo] }, filters, includeSymbols)
  const targetPaths = TARGETS.map((i) => `small/a${i}.ts`)

  beforeAll(async () => {
    const owner = await createActiveUser()
    const [row] = await db.insert(repositories).values({ name: 'filters', ownerId: owner.id, ingestionMethod: 'agent_push' }).returning()
    repo = row!.id
    ownerEmail = owner.email
    const files = [
      ...Array.from({ length: NOISE }, (_, i) => ({ path: `big/f${i}.py`, content: 'starve query\n' })),
      ...TARGETS.map((i) => ({ path: `small/a${i}.ts`, content: 'starve\n' })),
    ]
    await syncRepositoryFiles(repo, files, files.map((f) => f.path))
    await flushExtraction()
  }, 300_000)

  it('the unfiltered top k holds no target', async () => {
    const answer = await code({})
    expect(answer.results).toHaveLength(TARGETS.length)
    expect(answer.results.filter((r) => r.path.startsWith('small/'))).toEqual([])
  })

  it('languages, and types (a code file\'s type is its language)', async () => {
    await inBothPlans(() => paths(code({ languages: ['typescript'] })), targetPaths)
    await inBothPlans(() => paths(code({ types: ['typescript'] })), targetPaths)
  })

  it('since and until', async () => {
    await db.execute(sql`UPDATE repository_files SET updated_at = CASE WHEN path LIKE 'small/%' THEN '2021-06-01'::timestamptz ELSE '2024-06-01'::timestamptz END WHERE repository_id = ${repo}`)
    await inBothPlans(() => paths(code({ until: '2022-01-01' })), targetPaths)
    await db.execute(sql`UPDATE repository_files SET updated_at = CASE WHEN path LIKE 'small/%' THEN '2024-06-01'::timestamptz ELSE '2021-06-01'::timestamptz END WHERE repository_id = ${repo}`)
    await inBothPlans(() => paths(code({ since: '2022-01-01' })), targetPaths)
  })

  it('path prefix and glob', async () => {
    await inBothPlans(() => paths(code({ path: 'small/' })), targetPaths)
    await inBothPlans(() => paths(code({ path: '**/*.ts' })), targetPaths)
  })

  it('the REST search takes them: languages, kinds, path', async () => {
    const app: FastifyInstance = await buildApp()
    await app.ready()
    try {
      const cookie = await loginCookie(app, ownerEmail)
      const get = async (filters: string) => {
        const res = await app.inject({ method: 'GET', url: `/api/repositories/${repo}/search?q=starve%20query&limit=5&${filters}`, headers: { cookie } })
        expect(res.statusCode).toBe(200)
        return (res.json() as { results: Array<{ path: string }> }).results.map((r) => r.path)
      }
      expect(await get('languages=typescript')).toEqual(targetPaths)
      expect(await get('path=small/')).toEqual(targetPaths)
      expect(await get('kinds=class')).toEqual([])
    } finally {
      await app.close()
    }
  })

  it('symbol kinds, and types (a symbol\'s type is its kind)', async () => {
    // 40 functions named `widget` ahead (by path) of 5 classes named `Widget` whose snippets carry more words: every
    // symbol matches the keyword leg in one tier, and the functions are nearer in the vector leg.
    const owner = await createActiveUser()
    const [row] = await db.insert(repositories).values({ name: 'kinds', ownerId: owner.id, ingestionMethod: 'agent_push' }).returning()
    const files = [
      ...Array.from({ length: 40 }, (_, i) => ({ path: `k/f${i}.ts`, content: 'export function widget() { return 1 }\n' })),
      ...TARGETS.map((i) => ({ path: `z/c${i}.ts`, content: 'export class Widget { gear lever pulley spring axle cog }\n' })),
    ]
    await syncRepositoryFiles(row!.id, files, files.map((f) => f.path))
    await flushExtraction()
    const classes = TARGETS.map((i) => `symbol:z/c${i}.ts`)
    // Sorted: the classes' vector distances differ by their paths' words (the order is not what this checks).
    const hits = async (filters: Filters) =>
      (await searchNotes({ vaultIds: [], repositoryIds: [row!.id] }, 'widget', TARGETS.length, filters, { includeSymbols: true })).results
        .map((r) => `${r.resourceType}:${r.path}`)
        .sort()
    expect((await hits({})).filter((hit) => hit.startsWith('symbol:z/'))).toEqual([])
    await inBothPlans(() => hits({ kinds: ['class'] }), classes)
    await inBothPlans(() => hits({ types: ['class'] }), classes)
  }, 120_000)
})

describe('repository scope and a kind inside the symbol vector leg (#454)', () => {
  it('a small repository crowded out by a big one keeps its symbols', async () => {
    // 300 symbols of another repository (more than the leg's ef_search of 200) are all nearer the query than the
    // small repository's 5, which share one word with it, so only the vector leg can find them. The scope half
    // already holds on the base (#462's iterative scan; with `hnsw.iterative_scan` off it answers []); the kind
    // half fails there, where `kinds` is ignored.
    const owner = await createActiveUser()
    const repo = async (name: string, files: Array<{ path: string; content: string }>) => {
      const [row] = await db.insert(repositories).values({ name, ownerId: owner.id, ingestionMethod: 'agent_push' }).returning()
      await syncRepositoryFiles(row!.id, files, files.map((f) => f.path))
      await flushExtraction()
      return row!.id
    }
    await repo('crowd', Array.from({ length: 300 }, (_, i) => ({ path: `big/f${i}.ts`, content: 'export function starve() { return query }\n' })))
    const small = await repo('crowded-out', TARGETS.map((i) => ({ path: `s/a${i}.ts`, content: 'export function starve() {}\n' })))
    const expected = TARGETS.map((i) => `s/a${i}.ts`)
    await inBothPlans(async () => (await findSymbols([small], QUERY, { limit: TARGETS.length })).results.map((r) => r.path).sort(), expected)
    await inBothPlans(
      async () =>
        (await searchNotes({ vaultIds: [], repositoryIds: [small] }, QUERY, 20, { kinds: ['function'] } as Filters, { includeSymbols: true })).results
          .map((r) => r.path)
          .sort(),
      expected,
    )
  }, 120_000)
})
