import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { semanticEdges } from '../db/schema.js'
import { config } from '../config.js'

export type SemanticNodeType = 'note' | 'code'

interface Neighbor {
  type: SemanticNodeType
  id: string
  similarity: number
}

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * The nearest owners of one type to any of `vecs` (ADR-004 §2.5 roll-up): for
 * each query vector its 100 nearest blocks (`hnsw.ef_search` is 100 in
 * recomputeSemanticEdges's transaction, so HNSW returns at most that many),
 * then one row per owner with its best block's similarity. Notes count only
 * while live. The owner type is a literal, so the planner uses that type's
 * partial HNSW index (migration 0036).
 */
async function nearestOwners(
  client: DbOrTx,
  ownerType: SemanticNodeType,
  vecs: string,
  excludeId: string | null,
): Promise<Array<{ id: string; similarity: number }>> {
  return (await client.execute(sql`
    SELECT nearest.owner_id AS id, 1 - min(nearest.distance) AS similarity
    FROM unnest(${vecs}::text[]) AS q(vec)
    CROSS JOIN LATERAL (
      SELECT owner_id, embedding <=> q.vec::vector AS distance FROM blocks
      WHERE owner_type = ${sql.raw(`'${ownerType}'`)} AND embedding IS NOT NULL ${excludeId ? sql`AND owner_id <> ${excludeId}` : sql``}
      ORDER BY embedding <=> q.vec::vector
      LIMIT 100
    ) nearest
    ${ownerType === 'note' ? sql`JOIN notes n ON n.id = nearest.owner_id AND n.deleted_at IS NULL` : sql``}
    GROUP BY nearest.owner_id ORDER BY min(nearest.distance), nearest.owner_id
    LIMIT ${config.semanticK}`)) as unknown as Array<{ id: string; similarity: number }>
}

async function knn(
  vectors: readonly number[][],
  excludeType: SemanticNodeType,
  excludeId: string,
  client: DbOrTx = db,
): Promise<Neighbor[]> {
  // One Postgres text[] of vector literals: `[a,b,…]` holds no comma-quoting hazard inside `{"…","…"}`.
  const vecs = `{${vectors.map((v) => `"${JSON.stringify(v)}"`).join(',')}}`
  const noteRows = await nearestOwners(client, 'note', vecs, excludeType === 'note' ? excludeId : null)
  const codeRows = await nearestOwners(client, 'code', vecs, excludeType === 'code' ? excludeId : null)
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
 * queue and the repository file extraction queue. `vectors`: the node's
 * block vectors whose neighbours count (a note: all its blocks; a file: its
 * file-level block); a neighbour's similarity is that of its best block to
 * the best of these (ADR-004 §2.5).
 */
export async function recomputeSemanticEdges(
  nodeType: SemanticNodeType,
  nodeId: string,
  vectors: readonly number[][],
): Promise<void> {
  // The neighbours first, outside the transaction that locks the note: a note has a vector per block, so this
  // can take a while, and the FOR SHARE below would hold off every write to the note meanwhile (#452).
  const neighbors =
    vectors.length === 0
      ? []
      : (
          await db.transaction(async (tx) => {
            // ponytail: tuned HNSW ef_search = 100 preserves 99.8% recall while avoiding full-table sequential scans on every note edit (DB-02).
            await tx.execute(sql`set local hnsw.ef_search = 100`)
            return knn(vectors, nodeType, nodeId, tx)
          })
        ).filter((n) => n.similarity >= config.semanticThreshold)
  await db.transaction(async (tx) => {
    // A note purged while it was embedded keeps no edges: the row is locked
    // (FOR SHARE) for the transaction, so a purge either waits for it and then
    // deletes the edges, or ran first and nothing is written.
    if (nodeType === 'note') {
      const live = await tx.execute(sql`SELECT 1 FROM notes WHERE id = ${nodeId} FOR SHARE`)
      if ((live as unknown as unknown[]).length === 0) return
    }

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
