import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { semanticEdges } from '../db/schema.js'
import { config } from '../config.js'
import { recordJob } from '../monitoring/metrics.js'
import {
  JOB_PRIORITY,
  MAX_JOB_ATTEMPTS,
  catchUpLimits,
  claimJob,
  completeJob,
  failCrashedJobs,
  failJob,
  jobDrainer,
  onJobConflict,
  type JobRerun,
} from '../jobs/durable.js'
import { setHnswScan } from './hnsw.js'

export type SemanticNodeType = 'note' | 'code'

interface Neighbor {
  type: SemanticNodeType
  id: string
  path: string
  similarity: number
}

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

/** At most this many of a note's blocks, in body order, query its semantic neighbours. */
export const EDGE_QUERY_BLOCKS = 16

/** Blocks each vector looks at, in a node's own search and in the search for the nodes it entered. */
const WINDOW = 100

/**
 * Slack for a similarity compared with a stored one: `semantic_edges.similarity` is a `real`, rounded from
 * the double it was computed as, so an exact tie may read back a little above it.
 */
const STORED_SIMILARITY_SLACK = 1e-6

/**
 * The query vectors (`owner_id`, `vec`) of the owners of type `ownerType` in `ids` (a uuid[] expression;
 * ADR-004 §2.5): a note's first EDGE_QUERY_BLOCKS blocks in body order (the preamble and first sections:
 * each costs one HNSW search per owner type, and a very long note has hundreds), a file's file-level block.
 */
function queryVectors(ownerType: SemanticNodeType, ids: SQL): SQL {
  return ownerType === 'code'
    ? sql`SELECT b.owner_id, b.embedding AS vec FROM blocks b
        WHERE b.owner_type = 'code' AND b.owner_id = ANY(${ids}) AND b.kind = 'file' AND b.embedding IS NOT NULL`
    : sql`SELECT o.id AS owner_id, b.vec FROM unnest(${ids}) AS o(id)
        CROSS JOIN LATERAL (
          SELECT b.embedding AS vec FROM blocks b
          WHERE b.owner_type = 'note' AND b.owner_id = o.id AND b.embedding IS NOT NULL
          ORDER BY b.start_line, b.block_id
          LIMIT ${EDGE_QUERY_BLOCKS}
        ) b`
}

/** The live owners of type `ownerType`, joined as `o` on `ownerId` (an SQL column), for their path. */
function liveOwner(ownerType: SemanticNodeType, ownerId: SQL): SQL {
  return ownerType === 'note'
    ? sql`JOIN notes o ON o.id = ${ownerId} AND o.deleted_at IS NULL`
    : sql`JOIN repository_files o ON o.id = ${ownerId}`
}

/**
 * The nearest owners of one type to any of the query vectors `query` (ADR-004 §2.5 roll-up), among the
 * blocks of `containers` (a Postgres uuid[] literal of vault or repository ids; D10, #461): for each query
 * vector its WINDOW nearest blocks, then one row per owner with its best block's similarity. Notes count
 * only while live. Equal similarities are ordered by path, then id (#1007): never by id alone, which differs
 * between two instances holding the same content. The owner type is a literal, so the planner uses that
 * type's partial HNSW index (migration 0036), and the container filter applies during its scan: with
 * `hnsw.iterative_scan` (recomputeSemanticEdges's transaction) the scan goes on past `hnsw.ef_search`
 * candidates until WINDOW blocks of the containers are found, so a small vault in a big instance still gets
 * its neighbours. The ids are a literal too, so for a container small enough the planner reads its blocks by
 * `blocks_container_idx` and sorts them exactly instead.
 */
async function nearestOwners(
  client: DbOrTx,
  ownerType: SemanticNodeType,
  query: SQL,
  containers: string,
  excludeId: string,
): Promise<Array<{ id: string; path: string; similarity: number }>> {
  return (await client.execute(sql`
    SELECT nearest.owner_id AS id, o.path, 1 - min(nearest.distance) AS similarity
    FROM (${query}) q
    CROSS JOIN LATERAL (
      SELECT owner_id, embedding <=> q.vec AS distance FROM blocks
      WHERE owner_type = ${sql.raw(`'${ownerType}'`)} AND embedding IS NOT NULL AND container_id = ANY(${containers}::uuid[])
        AND owner_id <> ${excludeId}
      ORDER BY embedding <=> q.vec
      LIMIT ${WINDOW}
    ) nearest
    ${liveOwner(ownerType, sql`nearest.owner_id`)}
    GROUP BY nearest.owner_id, o.path
    ORDER BY min(nearest.distance), o.path COLLATE "C", nearest.owner_id
    LIMIT ${config.semanticK}`)) as unknown as Array<{ id: string; path: string; similarity: number }>
}

/**
 * Where a node's neighbours may come from (D10, #461), as uuid[] literals per
 * owner type: of its own type only its vault or repository (not another one
 * of the same owner), of the other type the owner's repositories or live
 * vaults. Null when the node is gone. The relation is symmetric: a node is in
 * the reach of exactly the nodes in its own reach.
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

/** Descending similarity, then path, then type, then id: a total order that holds no per-instance value but the last. */
function byRank(a: Neighbor, b: Neighbor): number {
  if (a.similarity !== b.similarity) return b.similarity - a.similarity
  for (const key of ['path', 'type', 'id'] as const) if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  return 0
}

/** A node's top-k across both types, from its stored query vectors (`queryVectors`). */
async function knn(client: DbOrTx, nodeType: SemanticNodeType, nodeId: string): Promise<Neighbor[]> {
  const scope = await neighbourScope(client, nodeType, nodeId)
  if (!scope) return []
  const query = queryVectors(nodeType, sql`ARRAY[${nodeId}]::uuid[]`)
  const nearest = async (type: SemanticNodeType) =>
    scope[type] === '{}' ? [] : (await nearestOwners(client, type, query, scope[type], nodeId)).map((r) => ({ type, ...r }))
  return [...(await nearest('note')), ...(await nearest('code'))].sort(byRank).slice(0, config.semanticK)
}

/**
 * Recomputes one node's semantic neighbours across both notes and code
 * (spec 9: one shared embedding space, semantic edges span both content
 * types) from its stored blocks, and stores the strong ones as the rows it
 * owns. A neighbour's similarity is that of its best block to the best of
 * the node's query vectors (`queryVectors`; ADR-004 §2.5).
 *
 * One transaction holds a lock on the node's id (an advisory lock: writes to
 * the note go on) from reading its vectors to writing its rows, so two
 * recomputes of one node (its own embed and another node's, see
 * `refreshSemanticEdges`) never leave the rows of the older vectors.
 */
export async function recomputeSemanticEdges(nodeType: SemanticNodeType, nodeId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`semantic_edges:${nodeType}:${nodeId}`}, 0))`)
    // ponytail: tuned HNSW ef_search = 100 preserves 99.8% recall while avoiding full-table sequential scans on every note edit (DB-02).
    // The container filter applies inside the HNSW scan (#461): with the iterative scan (pgvector 0.8+;
    // setHnswScan sets it only where it exists) the scan goes on until the LIMIT is met (up to
    // `hnsw.max_scan_tuples`, default 20,000); without it a container whose blocks are not among the
    // ef_search nearest gets no neighbours from the HNSW plan.
    await setHnswScan(tx, 100)
    const neighbors = (await knn(tx, nodeType, nodeId)).filter((n) => n.similarity >= config.semanticThreshold)

    // A note purged while it was embedded keeps no edges: the row is locked (FOR SHARE) for the rest of the
    // transaction, after the searches (a long note's searches never hold off writes to it, #452), so a purge
    // either waits for it and then deletes the edges, or ran first and nothing is written.
    if (nodeType === 'note') {
      const live = await tx.execute(sql`SELECT 1 FROM notes WHERE id = ${nodeId} FOR SHARE`)
      if ((live as unknown as unknown[]).length === 0) return
    }

    // Only this node's OWN edges. kNN is asymmetric — B can hold A in its top-k
    // while A does not hold B — so deleting by either side would wipe an edge B
    // owns (#91); B's rows are B's recompute's to write.
    await tx
      .delete(semanticEdges)
      .where(and(eq(semanticEdges.sourceType, nodeType), eq(semanticEdges.sourceId, nodeId)))

    if (neighbors.length === 0) return

    await tx
      .insert(semanticEdges)
      .values(
        neighbors.map((n) => ({
          sourceType: nodeType,
          sourceId: nodeId,
          targetType: n.type,
          targetId: n.id,
          similarity: n.similarity,
        })),
      )
      .onConflictDoUpdate({
        target: [semanticEdges.sourceType, semanticEdges.sourceId, semanticEdges.targetType, semanticEdges.targetId],
        set: { similarity: sql`excluded.similarity` },
      })
  })
}

/**
 * The nodes of type `ownerType` in `containers` whose top-k node `nodeId` may
 * now enter through its vectors with embed keys `newKeys` (#1007). Under the
 * invariant every stored top-k is that of the content it was computed from, a
 * node's top-k changes only if the node now holds `nodeId` or held it before
 * (`refreshSemanticEdges` takes those from the rows), and the new vectors are
 * the only way in. Three steps:
 * 1. per new vector, its WINDOW nearest query-capable blocks (a note's blocks,
 *    of which its query vectors are the first EDGE_QUERY_BLOCKS; a file's
 *    file-level block) in the containers: their owners;
 * 2. a node in none of the windows has a similarity to the new vectors of at
 *    most the nearest window edge (a window short of WINDOW blocks holds every
 *    such block in reach: then there is no such node). When every window is
 *    full and that edge is still above the threshold, such a node may admit
 *    `nodeId` anyway if its own list is weak (an outlier whose nearest node
 *    is this one): every node whose stored K-th similarity (the threshold
 *    below K rows) is at most that edge;
 * 3. each candidate's similarity to the new vectors, from its own query
 *    vectors, against its stored K-th similarity (or the threshold below K
 *    rows): only a node it beats is returned.
 */
async function enteredBy(
  client: DbOrTx,
  nodeType: SemanticNodeType,
  nodeId: string,
  newKeys: readonly string[],
  ownerType: SemanticNodeType,
  containers: string,
): Promise<string[]> {
  const vectors = sql`SELECT b.embedding AS vec FROM blocks b
    WHERE b.owner_type = ${nodeType} AND b.owner_id = ${nodeId} AND b.embed_key = ANY(${`{${newKeys.map((k) => JSON.stringify(k)).join(',')}}`}::text[])
      AND b.embedding IS NOT NULL`
  const windows = (await client.execute(sql`
    SELECT array_agg(DISTINCT w.owner_id) AS ids,
      CASE WHEN bool_and(w.n = ${WINDOW}) THEN 1 - min(w.far) END AS edge
    FROM (
      SELECT nearest.owner_id, count(*) OVER (PARTITION BY q.ord) AS n, max(nearest.distance) OVER (PARTITION BY q.ord) AS far
      FROM (SELECT row_number() OVER () AS ord, vec FROM (${vectors}) v) q
      CROSS JOIN LATERAL (
        SELECT owner_id, embedding <=> q.vec AS distance FROM blocks
        WHERE owner_type = ${sql.raw(`'${ownerType}'`)} AND embedding IS NOT NULL AND container_id = ANY(${containers}::uuid[])
          ${ownerType === 'code' ? sql`AND kind = 'file'` : sql``} AND owner_id <> ${nodeId}
        ORDER BY embedding <=> q.vec
        LIMIT ${WINDOW}
      ) nearest
    ) w`)) as unknown as [{ ids: string[] | null; edge: number | null }]
  const candidates = new Set(windows[0]?.ids ?? [])
  const edge = windows[0]?.edge ?? null
  if (edge !== null && edge >= config.semanticThreshold) {
    const owners =
      ownerType === 'note'
        ? sql`SELECT id FROM notes WHERE vault_id = ANY(${containers}::uuid[]) AND deleted_at IS NULL`
        : sql`SELECT id FROM repository_files WHERE repository_id = ANY(${containers}::uuid[])`
    const weak = (await client.execute(sql`
      SELECT o.id FROM (${owners}) o
      CROSS JOIN LATERAL (
        SELECT count(*) AS n, min(e.similarity) AS kth FROM semantic_edges e WHERE e.node_a_type = ${ownerType} AND e.node_a_id = o.id
      ) s
      WHERE o.id <> ${nodeId} AND (s.n < ${config.semanticK} OR s.kth <= ${edge + STORED_SIMILARITY_SLACK})`)) as unknown as Array<{ id: string }>
    for (const r of weak) candidates.add(r.id)
  }
  if (candidates.size === 0) return []
  const entered = (await client.execute(sql`
    SELECT q.owner_id AS id
    FROM (${queryVectors(ownerType, sql`${`{${[...candidates].join(',')}}`}::uuid[]`)}) q
    CROSS JOIN (${vectors}) v
    ${liveOwner(ownerType, sql`q.owner_id`)}
    CROSS JOIN LATERAL (
      SELECT count(*) AS n, min(e.similarity) AS kth FROM semantic_edges e WHERE e.node_a_type = ${ownerType} AND e.node_a_id = q.owner_id
    ) s
    GROUP BY q.owner_id, s.n, s.kth
    HAVING 1 - min(q.vec <=> v.vec) >= ${config.semanticThreshold}
      AND (s.n < ${config.semanticK} OR 1 - min(q.vec <=> v.vec) >= s.kth - ${STORED_SIMILARITY_SLACK})`)) as unknown as Array<{ id: string }>
  return entered.map((r) => r.id)
}

/**
 * After a node's vectors changed (#1007): the stored semantic edges are a
 * function of the content, not of the order it was embedded in. Recomputes
 * the node's own top-k, then that of every node whose top-k it can change:
 * those that hold it (its vectors moved, so their similarity to it did) and
 * those it now enters through `newKeys`, the embed keys of the vectors it did
 * not have before (`enteredBy`). Each recompute reads the stored blocks, so
 * the order of the recomputes does not matter. Costs one recompute (its HNSW
 * searches) per such node; measured in the PR for #1007.
 */
export async function refreshSemanticEdges(nodeType: SemanticNodeType, nodeId: string, newKeys: readonly string[]): Promise<void> {
  const affected = await db.transaction(async (tx) => {
    const holders = (await tx.execute(sql`
      SELECT node_a_type AS type, node_a_id AS id FROM semantic_edges
      WHERE node_b_type = ${nodeType} AND node_b_id = ${nodeId}
        AND (node_a_type = 'code' OR EXISTS (SELECT 1 FROM notes n WHERE n.id = node_a_id AND n.deleted_at IS NULL))`)) as unknown as Array<{
      type: SemanticNodeType
      id: string
    }>
    const found = holders.map((h) => `${h.type}:${h.id}`)
    const scope = newKeys.length > 0 ? await neighbourScope(tx, nodeType, nodeId) : null
    if (scope) {
      await setHnswScan(tx, 100)
      for (const type of ['note', 'code'] as const) {
        if (scope[type] === '{}') continue
        for (const id of await enteredBy(tx, nodeType, nodeId, newKeys, type, scope[type])) found.push(`${type}:${id}`)
      }
    }
    return [...new Set(found)].sort()
  })
  await recomputeSemanticEdges(nodeType, nodeId)
  for (const key of affected) {
    const [type, id] = key.split(':') as [SemanticNodeType, string]
    if (type !== nodeType || id !== nodeId) await recomputeSemanticEdges(type, id)
  }
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

/**
 * The rebuild (#1007): durable jobs (`jobs/durable.ts`), kind
 * `semantic_edges`, payload `{nodeType, nodeId}`, key
 * `semantic_edges:<type>:<id>`, each recomputing one node's top-k from its
 * stored blocks (`recomputeSemanticEdges`). Once every node has run, the
 * stored edges are those of the content whatever order it was embedded in.
 * Queued for every node by `pnpm reindex` and, once, by migration 0046.
 */
export const SEMANTIC_EDGES_JOB = 'semantic_edges'

async function drainRebuild(): Promise<void> {
  await failCrashedJobs(SEMANTIC_EDGES_JOB, 'semantic-edges', 'nodeId')
  for (;;) {
    const job = await claimJob<{ nodeType: SemanticNodeType; nodeId: string }>(SEMANTIC_EDGES_JOB)
    if (!job) return
    const { nodeType, nodeId } = job.payload
    try {
      await recomputeSemanticEdges(nodeType, nodeId)
      await completeJob(job.id)
      recordJob('semantic-edges', 'ok', nodeId)
    } catch (err) {
      const gaveUp = await failJob(job, err, 'semantic-edges', nodeId)
      console.warn(`[semantic-edges] ${nodeType} ${nodeId} (attempt ${job.attempts}/${MAX_JOB_ATTEMPTS}${gaveUp ? ', gave up' : ''}):`, err)
    }
  }
}

const rebuild = jobDrainer('semantic-edges', drainRebuild)

/**
 * Queues the rebuild job of every live note and every repository file, at
 * catch-up priority (behind the jobs of the server's writes), in keyset pages
 * of `catchUpLimits.batchSize` per type; `rerun: 'finished'` runs a finished
 * one again (`pnpm reindex`). Returns the nodes queued. Starts no drain: the
 * server's job polling or `runSemanticEdgeRebuild` runs them.
 */
export async function enqueueSemanticEdgeRebuild(rerun: JobRerun): Promise<number> {
  let queued = 0
  for (const [type, table, live] of [
    ['note', sql`notes`, sql`deleted_at IS NULL`],
    ['code', sql`repository_files`, sql`true`],
  ] as const) {
    let after: string | null = null
    for (;;) {
      const page = (await db.execute(sql`
        WITH page AS (
          SELECT id FROM ${table} WHERE ${live} ${after ? sql`AND id > ${after}::uuid` : sql``}
          ORDER BY id LIMIT ${catchUpLimits.batchSize}),
        queued AS (
          INSERT INTO jobs (kind, payload, idempotency_key, priority)
          SELECT ${SEMANTIC_EDGES_JOB}, jsonb_build_object('nodeType', ${type}::text, 'nodeId', page.id::text),
            ${SEMANTIC_EDGES_JOB} || ':' || ${type}::text || ':' || page.id, ${JOB_PRIORITY.catchUp}::smallint
          FROM page ORDER BY page.id
          ${onJobConflict(rerun)})
        SELECT id FROM page ORDER BY id`)) as unknown as Array<{ id: string }>
      queued += page.length
      if (page.length < catchUpLimits.batchSize) break
      after = page.at(-1)!.id
    }
  }
  return queued
}

/** Drains the rebuild jobs and awaits the drain: batch scripts and tests only. */
export async function runSemanticEdgeRebuild(): Promise<void> {
  rebuild.kick()
  await rebuild.flush()
}
