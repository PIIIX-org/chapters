/**
 * DIAGNOSTIC for #123 — not a permanent test. Builds its own adversarial
 * corpus so the result does not depend on what earlier test files leave in
 * `notes`, then runs the exact `knn()` query from src/search/semantic-edges.ts
 * under several planner/pgvector settings and prints a table.
 *
 * Hypothesis under test: a query vector that sits at cosine distance exactly
 * 1.0 from (nearly) the whole corpus — a one-hot fixture against the fake
 * embedder's sparse vectors — saturates HNSW's ef_search beam with ties, and
 * the greedy search never reaches the one element at distance 0.
 */
import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { db, sql as pg } from '../src/db/client.js'
import { notes, semanticEdges, vaults } from '../src/db/schema.js'
import { recomputeSemanticEdges } from '../src/search/semantic-edges.js'
import { createActiveUser } from './helpers.js'

const DIM = 384
const K = 8
const THRESHOLD = 0.2

function unitVector(axis: number): number[] {
  return Array.from({ length: DIM }, (_, i) => (i === axis ? 1 : 0))
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fake-embedder-shaped: a handful of ±1 axes, none of them axis 0, normalised. */
function sparseVector(rng: () => number): number[] {
  const v = new Array<number>(DIM).fill(0)
  for (let i = 0; i < 6; i++) {
    const axis = 1 + Math.floor(rng() * (DIM - 1))
    v[axis]! += rng() < 0.5 ? 1 : -1
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
  return v.map((x) => x / norm)
}

interface Row {
  id: string
  similarity: number
}

/** The knn() query, verbatim in shape, under explicit session settings. */
async function knn(settings: string[], vec: string, excludeId: string, withThreshold: boolean): Promise<Row[]> {
  return db.transaction(async (tx) => {
    for (const s of settings) await tx.execute(sql.raw(`set local ${s}`))
    const threshold = withThreshold
      ? sql`and 1 - (embedding <=> ${vec}::vector) >= ${THRESHOLD}`
      : sql``
    const rows = await tx.execute(sql`
      select id, 1 - (embedding <=> ${vec}::vector) as similarity
      from notes
      where deleted_at is null and embedding is not null and id <> ${excludeId} ${threshold}
      order by embedding <=> ${vec}::vector
      limit ${K}`)
    return [...(rows as unknown as Iterable<Row>)].map((r) => ({ id: r.id, similarity: Number(r.similarity) }))
  })
}

async function plan(vec: string, excludeId: string): Promise<string> {
  const rows = await db.execute(sql`
    explain select id from notes
    where deleted_at is null and embedding is not null and id <> ${excludeId}
    order by embedding <=> ${vec}::vector limit ${K}`)
  return [...(rows as unknown as Iterable<Record<string, string>>)]
    .map((r) => Object.values(r)[0])
    .join(' | ')
}

const CONFIGS: Array<{ name: string; settings: string[]; threshold: boolean }> = [
  { name: 'planner default', settings: [], threshold: false },
  { name: 'index, ef_search=40 (pgvector default)', settings: ['enable_seqscan = off'], threshold: false },
  { name: 'index, ef_search=200', settings: ['enable_seqscan = off', 'hnsw.ef_search = 200'], threshold: false },
  { name: 'index, ef_search=1000', settings: ['enable_seqscan = off', 'hnsw.ef_search = 1000'], threshold: false },
  {
    name: 'index, iterative relaxed_order + SQL threshold',
    settings: ['enable_seqscan = off', "hnsw.iterative_scan = 'relaxed_order'"],
    threshold: true,
  },
  {
    name: 'index, iterative strict_order + SQL threshold',
    settings: ['enable_seqscan = off', "hnsw.iterative_scan = 'strict_order'"],
    threshold: true,
  },
  { name: 'exact (enable_indexscan=off)', settings: ['enable_indexscan = off'], threshold: false },
]

const createdVaults: string[] = []

async function newVault(): Promise<string> {
  const owner = await createActiveUser()
  const [vault] = await db
    .insert(vaults)
    .values({ name: `hnsw-diag-${randomUUID()}`, ownerId: owner.id })
    .returning({ id: vaults.id })
  createdVaults.push(vault!.id)
  return vault!.id
}

async function insertNotes(vaultId: string, embeddings: number[][], prefix: string): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < embeddings.length; i += 200) {
    const chunk = embeddings.slice(i, i + 200)
    const rows = await db
      .insert(notes)
      .values(
        chunk.map((embedding, j) => ({
          vaultId,
          type: 'notes',
          name: `${prefix}-${i + j}-${randomUUID()}`,
          path: `notes/${prefix}-${i + j}-${randomUUID()}.md`,
          frontmatter: { type: 'notes' },
          body: prefix,
          embedding,
        })),
      )
      .returning({ id: notes.id })
    ids.push(...rows.map((r) => r.id))
  }
  return ids
}

async function report(label: string, queryId: string, targetId: string, vec: string): Promise<Record<string, boolean>> {
  const found: Record<string, boolean> = {}
  const lines: string[] = [`\n#123 ${label}`, `  plan: ${await plan(vec, queryId)}`]
  for (const c of CONFIGS) {
    const rows = await knn(c.settings, vec, queryId, c.threshold)
    const hit = rows.some((r) => r.id === targetId)
    found[c.name] = hit
    const maxSim = rows.length ? Math.max(...rows.map((r) => r.similarity)).toFixed(3) : '-'
    lines.push(`  ${hit ? 'HIT ' : 'MISS'}  rows=${rows.length}  maxSim=${maxSim}  ${c.name}`)
  }
  console.log(lines.join('\n'))
  return found
}

describe('#123 HNSW recall diagnostic', () => {
  afterAll(async () => {
    // Leave nothing behind for later files: rows out, then VACUUM so the HNSW
    // index drops the dead entries instead of carrying them into the next test.
    for (const id of createdVaults) {
      await db.delete(notes).where(eq(notes.vaultId, id))
      await db.delete(vaults).where(eq(vaults.id, id))
    }
    await pg.unsafe('vacuum notes')
  })

  for (const n of [60, 300, 1500]) {
    for (const order of ['target-first', 'target-last'] as const) {
      it(`n=${n} ${order}: exact scan always finds the identical vector`, async () => {
        const vaultId = await newVault()
        const rng = mulberry32(n * 7 + (order === 'target-first' ? 1 : 2))
        const vec = unitVector(0)
        const corpus = Array.from({ length: n }, () => sparseVector(rng))

        let queryId: string, targetId: string
        if (order === 'target-first') {
          const pair = await insertNotes(vaultId, [vec, vec], 'pair')
          queryId = pair[0]!
          targetId = pair[1]!
          await insertNotes(vaultId, corpus, 'corpus')
        } else {
          await insertNotes(vaultId, corpus, 'corpus')
          const pair = await insertNotes(vaultId, [vec, vec], 'pair')
          queryId = pair[0]!
          targetId = pair[1]!
        }

        const found = await report(`n=${n} ${order}`, queryId!, targetId!, JSON.stringify(vec))
        expect(found['exact (enable_indexscan=off)']).toBe(true)
      })
    }
  }

  it('n=300 with churn (each corpus note re-embedded twice: dead index entries)', async () => {
    const vaultId = await newVault()
    const rng = mulberry32(99)
    const vec = unitVector(0)
    const [queryId, targetId] = await insertNotes(vaultId, [vec, vec], 'pair')
    const corpusIds = await insertNotes(vaultId, Array.from({ length: 300 }, () => sparseVector(rng)), 'corpus')
    for (let round = 0; round < 2; round++) {
      for (const id of corpusIds) {
        await db.update(notes).set({ embedding: sparseVector(rng) }).where(eq(notes.id, id))
      }
    }
    const found = await report('n=300 churn x2', queryId!, targetId!, JSON.stringify(vec))
    expect(found['exact (enable_indexscan=off)']).toBe(true)
  })

  it('replays the flaky test on top of the n=1500 corpus', async () => {
    const vaultId = await newVault()
    const rng = mulberry32(2024)
    const vec = unitVector(0)
    await insertNotes(vaultId, Array.from({ length: 1500 }, () => sparseVector(rng)), 'corpus')
    const [noteA, noteB] = await insertNotes(vaultId, [vec, vec], 'pair')
    await recomputeSemanticEdges('note', noteA!, vec)
    const own = await db
      .select()
      .from(semanticEdges)
      .where(and(eq(semanticEdges.sourceType, 'note'), eq(semanticEdges.sourceId, noteA!)))
    console.log(
      `\n#123 replay: recomputeSemanticEdges wrote ${own.length} edge(s) for noteA; ` +
        `noteB present: ${own.some((e) => e.targetId === noteB)}`,
    )
  })
})
