import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { db } from '../src/db/client.js'
import { notes, semanticEdges, vaults } from '../src/db/schema.js'
import { recomputeSemanticEdges } from '../src/search/semantic-edges.js'
import { createActiveUser } from './helpers.js'

/** One-hot 384-d vector — matches `notes.embedding`'s declared dimensions. */
function unitVector(axis: number): number[] {
  return Array.from({ length: 384 }, (_, i) => (i === axis ? 1 : 0))
}

async function createNote(vaultId: string, name: string, embedding: number[]): Promise<string> {
  const [row] = await db
    .insert(notes)
    .values({
      vaultId,
      type: 'notes',
      name,
      path: `notes/${name}.md`,
      frontmatter: { type: 'notes' },
      body: name,
      embedding,
    })
    .returning({ id: notes.id })
  return row!.id
}

function edgesOwnedBy(nodeId: string) {
  return db
    .select()
    .from(semanticEdges)
    .where(and(eq(semanticEdges.sourceType, 'note'), eq(semanticEdges.sourceId, nodeId)))
}

let noteA: string
let noteB: string
const embeddingA = unitVector(0)

beforeAll(async () => {
  const owner = await createActiveUser()
  const [vault] = await db
    .insert(vaults)
    .values({ name: 'Semantic edges vault', ownerId: owner.id })
    .returning({ id: vaults.id })
  // Same axis => cosine similarity 1, so each is comfortably in the other's top-k.
  noteA = await createNote(vault!.id, `sem-a-${randomUUID()}`, embeddingA)
  noteB = await createNote(vault!.id, `sem-b-${randomUUID()}`, unitVector(0))
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

    await recomputeSemanticEdges('note', noteA, embeddingA)

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

    await recomputeSemanticEdges('note', noteA, embeddingA)

    const own = await edgesOwnedBy(noteA)
    expect(own.some((e) => e.targetId === stale)).toBe(false)
  })

  it('writes its rows source-first', async () => {
    await recomputeSemanticEdges('note', noteA, embeddingA)

    const own = await edgesOwnedBy(noteA)
    expect(own.length).toBeGreaterThan(0)
    expect(own.every((e) => e.sourceType === 'note' && e.sourceId === noteA)).toBe(true)
    expect(own.some((e) => e.targetId === noteB)).toBe(true)
  })
})
