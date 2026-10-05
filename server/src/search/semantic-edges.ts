import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { semanticEdges } from '../db/schema.js'
import { config } from '../config.js'
import { vectorStore } from './vector/index.js'

export type SemanticNodeType = 'note' | 'code'

/**
 * Recomputes one node's semantic neighbors across both notes and code
 * via Chroma vector store and stores the strong ones. Called by both the note
 * embedding queue and the repository file extraction queue.
 */
export async function recomputeSemanticEdges(
  nodeType: SemanticNodeType,
  nodeId: string,
  embedding: number[],
): Promise<void> {
  const knnResults = await vectorStore.knn(embedding, nodeType, nodeId, config.semanticK)
  const neighbors = knnResults.filter((n) => n.similarity >= config.semanticThreshold)

  await db.transaction(async (tx) => {
    // Only this node's OWN edges. kNN is asymmetric — B can hold A in its top-k
    // while A does not hold B — so deleting by either side would wipe an edge B
    // owns and nothing would restore it until B is re-embedded (#91).
    await tx
      .delete(semanticEdges)
      .where(and(eq(semanticEdges.sourceType, nodeType), eq(semanticEdges.sourceId, nodeId)))

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
