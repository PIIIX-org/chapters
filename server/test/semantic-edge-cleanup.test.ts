import { randomUUID } from 'node:crypto'
import { and, eq, or } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '../src/db/client.js'
import { repositories, semanticEdges, vaults } from '../src/db/schema.js'
import { createNote, purgeNote, softDeleteNote } from '../src/notes/store.js'
import { getRepositoryFile, syncRepositoryFiles } from '../src/repositories/store.js'
import type { SemanticNodeType } from '../src/search/semantic-edges.js'
import { createActiveUser } from './helpers.js'

/**
 * Edges are inserted by hand rather than via flushEmbeddings(): #92 is about a
 * node being the TARGET of someone else's edge, which kNN output cannot be made
 * to guarantee. The other end is a synthetic uuid — semanticEdges is polymorphic
 * and has no FK, which is exactly why nothing cascades.
 */
async function seedEdgesBothWays(type: SemanticNodeType, id: string): Promise<string> {
  const other = randomUUID()
  await db.insert(semanticEdges).values([
    { sourceType: type, sourceId: id, targetType: type, targetId: other, similarity: 0.9 },
    { sourceType: type, sourceId: other, targetType: type, targetId: id, similarity: 0.9 },
  ])
  return other
}

async function edgesTouching(type: SemanticNodeType, id: string) {
  return db
    .select()
    .from(semanticEdges)
    .where(
      or(
        and(eq(semanticEdges.sourceType, type), eq(semanticEdges.sourceId, id)),
        and(eq(semanticEdges.targetType, type), eq(semanticEdges.targetId, id)),
      ),
    )
}

describe('semantic edge cleanup on hard delete (#92)', () => {
  it('purgeNote clears the note’s semantic edges in both directions', async () => {
    const owner = await createActiveUser()
    const [vault] = await db
      .insert(vaults)
      .values({ name: 'edge-cleanup-notes', ownerId: owner.id })
      .returning()
    const note = await createNote(vault!.id, {
      type: 'notes',
      name: `purge-me-${Date.now()}`,
      body: 'Rocket engine design notes.',
    })
    const other = await seedEdgesBothWays('note', note.id)
    // The embedding queue may already have produced real edges for this note,
    // so assert the seeded pair is present rather than an exact total — the
    // point of the precondition is that both directions exist.
    const before = await edgesTouching('note', note.id)
    expect(before.filter((e) => e.sourceId === other || e.targetId === other)).toHaveLength(2)

    // purgeNote only touches an already soft-deleted note.
    expect(await softDeleteNote(vault!.id, note.path)).not.toBeNull()
    expect(await purgeNote(vault!.id, note.id)).toBe(true)

    expect(await edgesTouching('note', note.id)).toEqual([])
  })

  it('syncRepositoryFiles hard-delete clears the file’s semantic edges in both directions', async () => {
    const owner = await createActiveUser()
    const [repo] = await db
      .insert(repositories)
      .values({ name: 'edge-cleanup-repo', ownerId: owner.id, ingestionMethod: 'agent_push' })
      .returning()
    await syncRepositoryFiles(
      repo!.id,
      [
        { path: 'a.ts', content: 'aaa' },
        { path: 'gone.ts', content: 'bbb' },
      ],
      ['a.ts', 'gone.ts'],
    )
    const doomed = await getRepositoryFile(repo!.id, 'gone.ts')
    expect(doomed).not.toBeNull()
    await seedEdgesBothWays('code', doomed!.id)
    expect(await edgesTouching('code', doomed!.id)).toHaveLength(2)

    const result = await syncRepositoryFiles(repo!.id, [], ['a.ts'])
    expect(result.deleted).toBe(1)

    expect(await edgesTouching('code', doomed!.id)).toEqual([])
  })
})
