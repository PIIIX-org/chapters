import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '../src/db/client.js'
import { blocks, notes, semanticEdges, vaults } from '../src/db/schema.js'
import { recomputeSemanticEdges } from '../src/search/semantic-edges.js'
import { createActiveUser } from './helpers.js'

/** Dense 384-d normalized unit vector — avoids HNSW tie-breaking artifacts (#123). */
function denseVector(seed: number): number[] {
  const raw = Array.from({ length: 384 }, (_, i) => Math.sin(seed + i * 0.1))
  const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0))
  return raw.map((v) => v / norm)
}

/** A note whose blocks carry these vectors (one `section` block each; ADR-004 §2.5). */
async function createNote(vaultId: string, name: string, ...embeddings: number[][]): Promise<string> {
  const [row] = await db
    .insert(notes)
    .values({
      vaultId,
      type: 'notes',
      name,
      path: `notes/${name}.md`,
      frontmatter: { type: 'notes' },
      body: name,
    })
    .returning({ id: notes.id })
  await db.insert(blocks).values(
    embeddings.map((embedding, i) => ({
      ownerType: 'note' as const,
      ownerId: row!.id,
      containerId: vaultId,
      blockId: `b_test${i}`,
      kind: 'section',
      innerPath: `S${i}`,
      startLine: i + 1,
      endLine: i + 1,
      contentHash: 'test',
      ownerVersion: '1',
      embedKey: `test${i}`,
      embedding,
    })),
  )
  return row!.id
}

function edgesOwnedBy(nodeId: string) {
  return db
    .select()
    .from(semanticEdges)
    .where(and(eq(semanticEdges.sourceType, 'note'), eq(semanticEdges.sourceId, nodeId)))
}

let vaultId: string
let noteA: string
let noteB: string
const embeddingA = denseVector(1)

beforeAll(async () => {
  const owner = await createActiveUser()
  const [vault] = await db
    .insert(vaults)
    .values({ name: 'Semantic edges vault', ownerId: owner.id })
    .returning({ id: vaults.id })
  vaultId = vault!.id
  // Same dense vector => cosine similarity 1, so each is comfortably in the other's top-k.
  noteA = await createNote(vaultId, `sem-a-${randomUUID()}`, embeddingA)
  noteB = await createNote(vaultId, `sem-b-${randomUUID()}`, denseVector(1))
})

// Row-only fixtures (no note files): delete the vault so the CI
// vault-invariant gate (#578) never sees notes the store did not write.
afterAll(async () => {
  await db.delete(vaults).where(eq(vaults.id, vaultId))
})

describe('recomputeSemanticEdges', () => {
  it('keeps edges another node owns (#91)', async () => {
    // An edge B owns: B holds A in its top-k. Recomputing A must not touch it.
    await db
      .insert(semanticEdges)
      .values({
        sourceType: 'note',
        sourceId: noteB,
        targetType: 'note',
        targetId: noteA,
        similarity: 0.99,
      })
      .onConflictDoNothing()

    await recomputeSemanticEdges('note', noteA, [embeddingA])

    const survivors = await db
      .select()
      .from(semanticEdges)
      .where(and(eq(semanticEdges.sourceId, noteB), eq(semanticEdges.targetId, noteA)))
    expect(survivors).toHaveLength(1)
  })

  it('replaces the edges it owns', async () => {
    const stale = randomUUID()
    await db.insert(semanticEdges).values({
      sourceType: 'note',
      sourceId: noteA,
      targetType: 'note',
      targetId: stale,
      similarity: 0.9,
    })

    await recomputeSemanticEdges('note', noteA, [embeddingA])

    const own = await edgesOwnedBy(noteA)
    expect(own.some((e) => e.targetId === stale)).toBe(false)
  })

  it('writes its rows source-first', async () => {
    await recomputeSemanticEdges('note', noteA, [embeddingA])

    const own = await edgesOwnedBy(noteA)
    expect(own.length).toBeGreaterThan(0)
    expect(own.every((e) => e.sourceType === 'note' && e.sourceId === noteA)).toBe(true)
    expect(own.some((e) => e.targetId === noteB)).toBe(true)
  })

  it('a neighbour note counts once, with its best block; any of the source blocks can find it (#452)', async () => {
    // C: one block far from everything, one equal to D's only block.
    const noteC = await createNote(vaultId, `sem-c-${randomUUID()}`, denseVector(50), denseVector(90))
    const noteD = await createNote(vaultId, `sem-d-${randomUUID()}`, denseVector(90))
    await recomputeSemanticEdges('note', noteD, [denseVector(90)])
    const fromD = (await edgesOwnedBy(noteD)).filter((e) => e.targetId === noteC)
    expect(fromD).toHaveLength(1)
    expect(fromD[0]!.similarity).toBeGreaterThan(0.999)

    await recomputeSemanticEdges('note', noteC, [denseVector(50), denseVector(90)])
    expect((await edgesOwnedBy(noteC)).some((e) => e.targetId === noteD && e.similarity > 0.999)).toBe(true)
  })
})
