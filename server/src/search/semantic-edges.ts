import { and, eq, isNull, ne, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { notes, repositoryFiles, semanticEdges } from '../db/schema.js'
import { config } from '../config.js'

export type SemanticNodeType = 'note' | 'code'

interface Neighbor {
  type: SemanticNodeType
  id: string
  similarity: number
}

async function knn(
  vec: string,
  excludeType: SemanticNodeType,
  excludeId: string,
): Promise<Neighbor[]> {
  const noteRows = await db
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

  const codeRows = await db
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
  await db
    .delete(semanticEdges)
    .where(
      or(
        and(eq(semanticEdges.nodeAType, nodeType), eq(semanticEdges.nodeAId, nodeId)),
        and(eq(semanticEdges.nodeBType, nodeType), eq(semanticEdges.nodeBId, nodeId)),
      ),
    )

  const vec = JSON.stringify(embedding)
  const neighbors = (await knn(vec, nodeType, nodeId)).filter(
    (n) => n.similarity >= config.semanticThreshold,
  )
  if (neighbors.length === 0) return

  const self = { type: nodeType, id: nodeId }
  const rows = neighbors.map((n) => {
    const [a, b] = `${self.type}:${self.id}` < `${n.type}:${n.id}` ? [self, n] : [n, self]
    return {
      nodeAType: a.type,
      nodeAId: a.id,
      nodeBType: b.type,
      nodeBId: b.id,
      similarity: n.similarity,
    }
  })
  await db
    .insert(semanticEdges)
    .values(rows)
    .onConflictDoUpdate({
      target: [semanticEdges.nodeAType, semanticEdges.nodeAId, semanticEdges.nodeBType, semanticEdges.nodeBId],
      set: { similarity: sql`excluded.similarity` },
    })
}
