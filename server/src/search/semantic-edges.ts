import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { notes, repositoryFiles, semanticEdges } from '../db/schema.js'
import { config } from '../config.js'

export type SemanticNodeType = 'note' | 'code'

interface Neighbor {
  type: SemanticNodeType
  id: string
  similarity: number
}

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

async function knn(
  vec: string,
  excludeType: SemanticNodeType,
  excludeId: string,
  client: DbOrTx = db,
): Promise<Neighbor[]> {
  const noteRows = await client
    .select({ id: notes.id, similarity: sql<number>`1 - (${notes.embedding} <=> ${vec}::vector)` })
    .from(notes)
    .where(
      and(
        isNull(notes.deletedAt),
        sql`${notes.embedding} is not null`,
        excludeType === 'note' ? ne(notes.id, excludeId) : sql`true`,
      ),
    )
    .orderBy(sql`${notes.embedding} <=> ${vec}::vector`)
    .limit(config.semanticK)

  const codeRows = await client
    .select({
      id: repositoryFiles.id,
      similarity: sql<number>`1 - (${repositoryFiles.embedding} <=> ${vec}::vector)`,
    })
    .from(repositoryFiles)
    .where(
      and(
        sql`${repositoryFiles.embedding} is not null`,
        excludeType === 'code' ? ne(repositoryFiles.id, excludeId) : sql`true`,
      ),
    )
    .orderBy(sql`${repositoryFiles.embedding} <=> ${vec}::vector`)
    .limit(config.semanticK)

  return [
    ...noteRows.map((r) => ({ type: 'note' as const, id: r.id, similarity: r.similarity })),
    ...codeRows.map((r) => ({ type: 'code' as const, id: r.id, similarity: r.similarity })),
  ]
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, config.semanticK)
}

/**
 * Recomputes one node's semantic neighbors across both notes and code
 * (spec 9: one shared embedding space, semantic edges span both content
 * types) and stores the strong ones. Called by both the note embedding
 * queue and the repository file extraction queue.
 */
export async function recomputeSemanticEdges(
  nodeType: SemanticNodeType,
  nodeId: string,
  embedding: number[],
): Promise<void> {
  await db.transaction(async (tx) => {
    // ponytail: exact scan for offline recompute ensures 100% recall even when HNSW
    // loses ties or elements are isolated by dead index entries (#123). Request-path
    // search in search.ts remains index-backed.
    await tx.execute(sql`set local enable_indexscan = off`)

    // Only this node's OWN edges. kNN is asymmetric — B can hold A in its top-k
    // while A does not hold B — so deleting by either side would wipe an edge B
    // owns and nothing would restore it until B is re-embedded (#91).
    await tx
      .delete(semanticEdges)
      .where(and(eq(semanticEdges.sourceType, nodeType), eq(semanticEdges.sourceId, nodeId)))

    const vec = JSON.stringify(embedding)
    const neighbors = (await knn(vec, nodeType, nodeId, tx)).filter(
      (n) => n.similarity >= config.semanticThreshold,
    )
    if (neighbors.length === 0) return

    const rows = neighbors.map((n) => ({
      sourceType: nodeType,
      sourceId: nodeId,
      targetType: n.type,
      targetId: n.id,
      similarity: n.similarity,
    }))
    await tx
      .insert(semanticEdges)
      .values(rows)
      .onConflictDoUpdate({
        target: [
          semanticEdges.sourceType,
          semanticEdges.sourceId,
          semanticEdges.targetType,
          semanticEdges.targetId,
        ],
        set: { similarity: sql`excluded.similarity` },
      })
  })
}

/** Removes every semantic edge touching a node, in both directions. */
export async function deleteSemanticEdgesFor(
  nodeType: SemanticNodeType,
  nodeIds: string[],
): Promise<void> {
  if (nodeIds.length === 0) return
  await db
    .delete(semanticEdges)
    .where(
      or(
        and(eq(semanticEdges.sourceType, nodeType), inArray(semanticEdges.sourceId, nodeIds)),
        and(eq(semanticEdges.targetType, nodeType), inArray(semanticEdges.targetId, nodeIds)),
      ),
    )
}
