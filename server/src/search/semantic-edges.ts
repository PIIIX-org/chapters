import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { notes, semanticEdges } from '../db/schema.js'
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

  // A file's similarity is its best block's (ADR-004 §2.5): the nearest blocks, then one row per file.
  // `hnsw.ef_search` is 100 in recomputeSemanticEdges's transaction, so at most 100 blocks come back.
  const codeRows = (await client.execute(sql`
    SELECT owner_id AS id, 1 - min(distance) AS similarity FROM (
      SELECT owner_id, embedding <=> ${vec}::vector AS distance FROM blocks
      WHERE owner_type = 'code' AND embedding IS NOT NULL ${excludeType === 'code' ? sql`AND owner_id <> ${excludeId}` : sql``}
      ORDER BY embedding <=> ${vec}::vector
      LIMIT 100
    ) nearest
    GROUP BY owner_id ORDER BY min(distance), owner_id
    LIMIT ${config.semanticK}`)) as unknown as Array<{ id: string; similarity: number }>

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
    // A note purged while it was embedded keeps no edges: the row is locked
    // (FOR SHARE) for the transaction, so a purge either waits for it and then
    // deletes the edges, or ran first and nothing is written.
    if (nodeType === 'note') {
      const live = await tx.execute(sql`SELECT 1 FROM notes WHERE id = ${nodeId} FOR SHARE`)
      if ((live as unknown as unknown[]).length === 0) return
    }
    // ponytail: tuned HNSW ef_search = 100 preserves 99.8% recall while avoiding full-table sequential scans on every note edit (DB-02).
    await tx.execute(sql`set local hnsw.ef_search = 100`)

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

/** Removes every semantic edge touching a node, in both directions (inside `client`'s transaction when given). */
export async function deleteSemanticEdgesFor(
  nodeType: SemanticNodeType,
  nodeIds: string[],
  client: DbOrTx = db,
): Promise<void> {
  if (nodeIds.length === 0) return
  await client
    .delete(semanticEdges)
    .where(
      or(
        and(eq(semanticEdges.sourceType, nodeType), inArray(semanticEdges.sourceId, nodeIds)),
        and(eq(semanticEdges.targetType, nodeType), inArray(semanticEdges.targetId, nodeIds)),
      ),
    )
}
