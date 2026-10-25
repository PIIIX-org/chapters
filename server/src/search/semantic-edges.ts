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
 * The nearest owners of one type to any of `vecs` (ADR-004 §2.5 roll-up),
 * among the blocks of `containers` (a Postgres uuid[] literal of vault or
 * repository ids; D10, #461): for each query vector its 100 nearest blocks,
 * then one row per owner with its best block's similarity. Notes count only
 * while live. The owner type is a literal, so the planner uses that type's
 * partial HNSW index (migration 0036), and the container filter applies
 * during its scan: with `hnsw.iterative_scan` (recomputeSemanticEdges's
 * transaction) the scan goes on past `hnsw.ef_search` candidates until 100
 * blocks of the containers are found, so a small vault in a big instance
 * still gets its neighbours. The ids are a literal too, so for a container
 * small enough the planner reads its blocks by `blocks_container_idx` and
 * sorts them exactly instead.
 */
async function nearestOwners(
  client: DbOrTx,
  ownerType: SemanticNodeType,
  vecs: string,
  containers: string,
  excludeId: string | null,
): Promise<Array<{ id: string; similarity: number }>> {
  return (await client.execute(sql`
    SELECT nearest.owner_id AS id, 1 - min(nearest.distance) AS similarity
    FROM unnest(${vecs}::text[]) AS q(vec)
    CROSS JOIN LATERAL (
      SELECT owner_id, embedding <=> q.vec::vector AS distance FROM blocks
      WHERE owner_type = ${sql.raw(`'${ownerType}'`)} AND embedding IS NOT NULL AND container_id = ANY(${containers}::uuid[])
        ${excludeId ? sql`AND owner_id <> ${excludeId}` : sql``}
      ORDER BY embedding <=> q.vec::vector
      LIMIT 100
    ) nearest
    ${ownerType === 'note' ? sql`JOIN notes n ON n.id = nearest.owner_id AND n.deleted_at IS NULL` : sql``}
    GROUP BY nearest.owner_id ORDER BY min(nearest.distance), nearest.owner_id
    LIMIT ${config.semanticK}`)) as unknown as Array<{ id: string; similarity: number }>
}

/**
 * Where a node's neighbours may come from (D10, #461), as uuid[] literals per
 * owner type: of its own type only its vault or repository (not another one
 * of the same owner), of the other type the owner's repositories or live
 * vaults. Null when the node is gone.
 */
async function neighbourScope(
  client: DbOrTx,
  nodeType: SemanticNodeType,
  nodeId: string,
): Promise<Record<SemanticNodeType, string> | null> {
  const [scope] = (await client.execute(
    nodeType === 'note'
      ? sql`SELECT ARRAY[n.vault_id]::text AS note,
          ARRAY(SELECT r.id FROM repositories r WHERE r.owner_id = v.owner_id ORDER BY r.id)::text AS code
          FROM notes n JOIN vaults v ON v.id = n.vault_id WHERE n.id = ${nodeId}`
      : sql`SELECT ARRAY[f.repository_id]::text AS code,
          ARRAY(SELECT v.id FROM vaults v WHERE v.owner_id = r.owner_id AND v.deleted_at IS NULL ORDER BY v.id)::text AS note
          FROM repository_files f JOIN repositories r ON r.id = f.repository_id WHERE f.id = ${nodeId}`,
  )) as unknown as Array<Record<SemanticNodeType, string>>
  return scope ?? null
}

async function knn(
  vectors: readonly number[][],
  nodeType: SemanticNodeType,
  nodeId: string,
  client: DbOrTx = db,
): Promise<Neighbor[]> {
  const scope = await neighbourScope(client, nodeType, nodeId)
  if (!scope) return []
  // One Postgres text[] of vector literals: `[a,b,…]` holds no comma-quoting hazard inside `{"…","…"}`.
  const vecs = `{${vectors.map((v) => `"${JSON.stringify(v)}"`).join(',')}}`
  const nearest = async (type: SemanticNodeType) =>
    scope[type] === '{}' ? [] : (await nearestOwners(client, type, vecs, scope[type], type === nodeType ? nodeId : null)).map((r) => ({ type, id: r.id, similarity: r.similarity }))
  return [...(await nearest('note')), ...(await nearest('code'))].sort((a, b) => b.similarity - a.similarity).slice(0, config.semanticK)
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
            // The container filter applies inside the HNSW scan (#461): pgvector 0.8+ goes on scanning until the LIMIT
            // is met (up to `hnsw.max_scan_tuples`, default 20,000). Older versions reserve the `hnsw.` prefix without
            // the setting, so it is set only where it exists; there a container whose blocks are not among the
            // ef_search nearest gets no neighbours from the HNSW plan.
            await tx.execute(sql`SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true) FROM pg_extension
              WHERE extname = 'vector' AND string_to_array(extversion, '.')::int[] >= '{0,8}'`)
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

/**
 * After a vault changes owner (inside the transfer's transaction): its notes' note↔code edges, both
 * directions, joined the previous owner's repositories, so they go (D10, #461). Each end gets the new
 * owner's code neighbours at its next recompute; note→note edges stay, the vault is the same.
 */
export async function deleteVaultCodeEdges(vaultId: string, client: DbOrTx = db): Promise<void> {
  await client.execute(sql`
    DELETE FROM semantic_edges e USING notes n WHERE n.vault_id = ${vaultId}
      AND ((e.node_a_type = 'note' AND e.node_a_id = n.id AND e.node_b_type = 'code')
        OR (e.node_b_type = 'note' AND e.node_b_id = n.id AND e.node_a_type = 'code'))`)
}
