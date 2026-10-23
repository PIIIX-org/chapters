import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { notes, repositories, vaults } from '../src/db/schema.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { embedder } from '../src/search/embeddings.js'
import { findSymbols, searchNotes } from '../src/search/search.js'
import { createActiveUser } from './helpers.js'

// #623 / ADR-004 §2.3: equal scores are ordered by path (code unit, i.e.
// COLLATE "C") then id, in every candidate cut and in the fused sort, so the
// same query on the same content answers in one order regardless of the
// order rows were written in.

let app: FastifyInstance
beforeAll(async () => {
  app = await buildApp()
  await app.ready()
})
afterAll(async () => app.close())

// 36 case variants of one word (more than the 30-row candidate cut). The
// test embedder lower-cases its words, so every path embeds identically and
// every leg scores them exactly equal; case also makes a locale collation
// disagree with code-unit order.
const VARIANTS = Array.from({ length: 36 }, (_, i) =>
  [...'tiebrk'].map((c, bit) => ((i >> bit) & 1 ? c.toUpperCase() : c)).join(''),
)
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
// Write orders that are neither sorted nor each other's mirror image.
const shuffled = (xs: string[]) => xs.map((_, i) => xs[(i * 7) % xs.length]!)
const reversed = (xs: string[]) => [...xs].sort(byCodeUnit).reverse()

const CONTENT = 'export function tieBreakerWidget() { return 42 }\n'
const CODE_PATHS = VARIANTS.map((v) => `src/${v}.ts`)
const CODE_SORTED = [...CODE_PATHS].sort(byCodeUnit)

async function repoWith(paths: string[]) {
  const owner = await createActiveUser()
  const [repo] = await db
    .insert(repositories)
    .values({ name: 'tie-break', ownerId: owner.id, ingestionMethod: 'agent_push' })
    .returning()
  // syncRepositoryFiles inserts one row per file, in the given order.
  await syncRepositoryFiles(
    repo!.id,
    paths.map((path) => ({ path, content: CONTENT })),
    paths,
  )
  await flushExtraction()
  return repo!.id
}

describe('search total order on equal scores (#623)', () => {
  it('orders equal-score code hits by path regardless of write order, on every call', async () => {
    const a = await repoWith(shuffled(CODE_PATHS))
    const b = await repoWith(reversed(CODE_PATHS))
    const run = async (id: string) =>
      (await searchNotes({ vaultIds: [], repositoryIds: [id] }, 'tieBreakerWidget', 20)).map((r) => r.path)

    const first = await run(a)
    expect(first).toEqual(CODE_SORTED.slice(0, 20))
    expect(await run(a)).toEqual(first)
    expect(await run(b)).toEqual(first)
  })

  it('orders equal-score symbol hits by path in findSymbols and searchNotes(includeSymbols)', async () => {
    const a = await repoWith(shuffled(CODE_PATHS))
    const b = await repoWith(reversed(CODE_PATHS))
    const syms = async (id: string) => (await findSymbols([id], 'tieBreakerWidget', { limit: 20 })).map((r) => r.path)
    expect(await syms(a)).toEqual(CODE_SORTED.slice(0, 20))
    expect(await syms(b)).toEqual(CODE_SORTED.slice(0, 20))

    const mixed = async (id: string) =>
      (await searchNotes({ vaultIds: [], repositoryIds: [id] }, 'tieBreakerWidget', 40, {}, { includeSymbols: true }))
        .filter((r) => r.resourceType === 'symbol')
        .map((r) => r.path)
    const fromA = await mixed(a)
    expect(fromA).toEqual(CODE_SORTED.slice(0, fromA.length))
    expect(await mixed(b)).toEqual(fromA)
  })

  it('orders equal-score note hits by path regardless of write order', async () => {
    const owner = await createActiveUser()
    const notePaths = VARIANTS.map((v) => `docs/${v}`)
    // Written straight to the table with one shared embedding and
    // frontmatter: the save path embeds the path and a per-note timestamp.
    const [embedding] = await embedder.embed(['identical tiebreakerwidget body'])
    const vaultWith = async (order: string[]) => {
      const [vault] = await db.insert(vaults).values({ name: 'tie-vault', ownerId: owner.id }).returning()
      for (const path of order) {
        await db.insert(notes).values({
          vaultId: vault!.id,
          type: 'docs',
          name: path.slice(5),
          path,
          frontmatter: { type: 'docs' },
          body: 'identical tiebreakerwidget body',
          embedding,
        })
      }
      return vault!.id
    }
    const a = await vaultWith(shuffled(notePaths))
    const b = await vaultWith(reversed(notePaths))
    const run = async (id: string) =>
      (await searchNotes({ vaultIds: [id], repositoryIds: [] }, 'tiebreakerwidget', 20)).map((r) => r.path)
    const first = await run(a)
    expect(first).toEqual([...notePaths].sort(byCodeUnit).slice(0, 20))
    expect(await run(a)).toEqual(first)
    expect(await run(b)).toEqual(first)
  })
})
