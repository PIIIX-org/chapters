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
  jobTiming,
  onJobConflict,
  type JobRerun,
} from '../jobs/durable.js'
import { setHnswScan } from './hnsw.js'

export type SemanticNodeType = 'note' | 'code'

interface Neighbor {
  type: SemanticNodeType
  id: string
  path: string
  /** The name of its vault or repository. */
  container: string
  similarity: number
}

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

/** At most this many of a note's blocks, in body order, query its semantic neighbours. */
export const EDGE_QUERY_BLOCKS = 16

/** Blocks each vector looks at, in a node's own search and in the search for the nodes it entered. */
const WINDOW = 100

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

/**
 * The live owners of type `ownerType`, joined as `o` on `ownerId` (an SQL column), with their vault or
 * repository as `ct`: their tie key (path, then container name; #1007).
 */
function liveOwner(ownerType: SemanticNodeType, ownerId: SQL): SQL {
  return ownerType === 'note'
    ? sql`JOIN notes o ON o.id = ${ownerId} AND o.deleted_at IS NULL JOIN vaults ct ON ct.id = o.vault_id`
    : sql`JOIN repository_files o ON o.id = ${ownerId} JOIN repositories ct ON ct.id = o.repository_id`
}

/**
 * The nearest owners of one type to any of the query vectors `query` (ADR-004 §2.5 roll-up), among the
 * blocks of `containers` (a Postgres uuid[] literal of vault or repository ids; D10, #461): for each query
 * vector its `window` nearest blocks (all of them when null), then one row per owner with its best block's
 * similarity, the first SEMANTIC_K by `byRank` (similarity, then path and container name; #1007). Notes
 * count only while live. Also `edge`: the highest similarity at the far end of a full window (null when
 * none is full), so the caller knows whether an owner outside the windows could rank among these
 * (`exactNearestOwners`). The owner type is a literal, so the planner uses that type's partial HNSW index
 * (migration 0036), and the container filter applies during its scan: with `hnsw.iterative_scan`
 * (recomputeSemanticEdges's transaction) the scan goes on past `hnsw.ef_search` candidates until the window
 * is full, so a small vault in a big instance still gets its neighbours. The ids are a literal too, so for a
 * container small enough the planner reads its blocks by `blocks_container_idx` and sorts them exactly
 * instead. Without a window there is no ORDER BY either: an HNSW scan without a LIMIT stops at
 * `ef_search` rows, a plain scan of the containers' blocks reads them all.
 */
async function nearestOwners(
  client: DbOrTx,
  ownerType: SemanticNodeType,
  query: SQL,
  containers: string,
  excludeId: string,
  window: number | null,
): Promise<{ owners: Array<{ id: string; path: string; container: string; similarity: number }>; edge: number | null }> {
  // Ordered by the similarity itself, not the distance: two distances may give one similarity, which `byRank` then
  // orders by the tie key, so the cut here and the merge there agree.
  const rows = (await client.execute(sql`
    WITH q AS (SELECT row_number() OVER () AS ord, x.vec FROM (${query}) x),
    nearest AS (
      SELECT q.ord, w.owner_id, w.distance FROM q
      CROSS JOIN LATERAL (
        SELECT owner_id, embedding <=> q.vec AS distance FROM blocks
        WHERE owner_type = ${sql.raw(`'${ownerType}'`)} AND embedding IS NOT NULL AND container_id = ANY(${containers}::uuid[])
          AND owner_id <> ${excludeId}
        ${window === null ? sql`` : sql`ORDER BY embedding <=> q.vec LIMIT ${window}`}
      ) w),
    windows AS (
      SELECT max(1 - far) AS edge FROM (SELECT max(distance) AS far FROM nearest GROUP BY ord HAVING count(*) = ${window ?? -1}) f)
    SELECT windows.edge, top.* FROM windows
    LEFT JOIN LATERAL (
      SELECT nearest.owner_id AS id, o.path, ct.name AS container, 1 - min(nearest.distance) AS similarity
      FROM nearest
      ${liveOwner(ownerType, sql`nearest.owner_id`)}
      GROUP BY nearest.owner_id, o.path, ct.name
      ORDER BY 1 - min(nearest.distance) DESC, o.path COLLATE "C", ct.name COLLATE "C", nearest.owner_id
      LIMIT ${config.semanticK}
    ) top ON true`)) as unknown as Array<{ edge: number | null; id: string | null; path: string; container: string; similarity: number }>
  return {
    edge: rows[0]?.edge ?? null,
    owners: rows.flatMap((r) => (r.id === null ? [] : [{ id: r.id, path: r.path, container: r.container, similarity: r.similarity }])),
  }
}

/**
 * `nearestOwners`, made exact: the stored edges are a node's true top-k by best-block similarity, so an embed
 * can merge itself into the lists it enters (`mergeEntered`) and a rebuild gives the same rows. An owner
 * outside every window has a similarity of at most the windows' `edge`; when that edge reaches the bound
 * the owners found must beat (the K-th's similarity, or SEMANTIC_THRESHOLD below K or under it), an owner
 * outside could rank among them, or tie with the K-th and come first by path: the windows widen (100, then
 * 1,000 blocks, then all the containers' blocks). Usually the first is enough; many equal similarities (one
 * content in many files) take a wider one.
 */
async function exactNearestOwners(
  client: DbOrTx,
  ownerType: SemanticNodeType,
  query: SQL,
  containers: string,
  excludeId: string,
): Promise<Array<{ id: string; path: string; container: string; similarity: number }>> {
  for (const window of [WINDOW, 10 * WINDOW, null]) {
    const { owners, edge } = await nearestOwners(client, ownerType, query, containers, excludeId, window)
    const kth = owners.length >= config.semanticK ? owners[config.semanticK - 1]!.similarity : -Infinity
    if (edge === null || edge < Math.max(kth, config.semanticThreshold)) return owners
  }
  throw new Error('unreachable: a scan without a window is exact')
}

/** What `nodeContext` reads of a node. */
interface NodeContext {
  /** Where its neighbours may come from, as uuid[] literals per owner type. */
  scope: Record<SemanticNodeType, string>
  /** Its tie key (`byRank`). */
  path: string
  container: string
  /** False for a note in the trash. */
  live: boolean
  /** `type:id` of the live nodes whose rows name it (with `holders`). */
  holders: string[]
}

/**
 * A node's context, in one statement: where its neighbours may come from (D10, #461): of its own type only
 * its vault or repository (not another one of the same owner), of the other type the owner's repositories
 * or live vaults; its tie key; and with `holders` the live nodes whose rows name it. The relation is
 * symmetric: a node is in the reach of exactly the nodes in its own reach. With `lock`, the statement also
 * takes the node's advisory lock for the transaction (`recomputeSemanticEdges`). Null when the node is gone.
 */
async function nodeContext(
  client: DbOrTx,
  nodeType: SemanticNodeType,
  nodeId: string,
  options: { lock?: boolean; holders?: boolean } = {},
): Promise<NodeContext | null> {
  const lock = options.lock ? sql`(SELECT pg_advisory_xact_lock(hashtextextended(${`semantic_edges:${nodeType}:${nodeId}`}, 0))) l CROSS JOIN` : sql``
  const holders = options.holders
    ? sql`ARRAY(SELECT e.node_a_type || ':' || e.node_a_id FROM semantic_edges e
        WHERE e.node_b_type = ${nodeType} AND e.node_b_id = ${nodeId}
          AND (e.node_a_type = 'code' OR EXISTS (SELECT 1 FROM notes h WHERE h.id = e.node_a_id AND h.deleted_at IS NULL)))`
    : sql`ARRAY[]::text[]`
  const [row] = (await client.execute(
    nodeType === 'note'
      ? sql`SELECT ARRAY[n.vault_id]::text AS note,
          ARRAY(SELECT r.id FROM repositories r WHERE r.owner_id = v.owner_id ORDER BY r.id)::text AS code,
          n.path, v.name AS container, n.deleted_at IS NULL AS live, ${holders} AS holders
          FROM ${lock} notes n JOIN vaults v ON v.id = n.vault_id WHERE n.id = ${nodeId}`
      : sql`SELECT ARRAY[f.repository_id]::text AS code,
          ARRAY(SELECT v.id FROM vaults v WHERE v.owner_id = r.owner_id AND v.deleted_at IS NULL ORDER BY v.id)::text AS note,
          f.path, r.name AS container, true AS live, ${holders} AS holders
          FROM ${lock} repository_files f JOIN repositories r ON r.id = f.repository_id WHERE f.id = ${nodeId}`,
  )) as unknown as Array<Record<SemanticNodeType, string> & Omit<NodeContext, 'scope'>>
  return row ? { scope: { note: row.note, code: row.code }, path: row.path, container: row.container, live: row.live, holders: row.holders } : null
}

/**
 * Descending similarity, then path, type, the name of the vault or repository and id, strings in byte order
 * (Postgres `COLLATE "C"`, as `nearestOwners` and `enteredBy` sort): a total order in which only the last key
 * is a per-instance value, deciding only two nodes of one path and type in two containers of one name.
 */
function byRank(a: Neighbor, b: Neighbor): number {
  if (a.similarity !== b.similarity) return b.similarity - a.similarity
  for (const key of ['path', 'type', 'container', 'id'] as const) {
    const order = Buffer.compare(Buffer.from(a[key]), Buffer.from(b[key]))
    if (order !== 0) return order
  }
  return 0
}

/** A node's top-k across both types, from its stored query vectors (`queryVectors`), within `scope`. */
async function knn(client: DbOrTx, nodeType: SemanticNodeType, nodeId: string, scope: Record<SemanticNodeType, string>): Promise<Neighbor[]> {
  const query = queryVectors(nodeType, sql`ARRAY[${nodeId}]::uuid[]`)
  const nearest = async (type: SemanticNodeType) =>
    scope[type] === '{}' ? [] : (await exactNearestOwners(client, type, query, scope[type], nodeId)).map((r) => ({ type, ...r }))
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
    const context = await nodeContext(tx, nodeType, nodeId, { lock: true })
    if (!context) return
    // ponytail: tuned HNSW ef_search = 100 preserves 99.8% recall while avoiding full-table sequential scans on every note edit (DB-02).
    // The container filter applies inside the HNSW scan (#461): with the iterative scan (pgvector 0.8+;
    // setHnswScan sets it only where it exists) the scan goes on until the LIMIT is met (up to
    // `hnsw.max_scan_tuples`, default 20,000); without it a container whose blocks are not among the
    // ef_search nearest gets no neighbours from the HNSW plan.
    await setHnswScan(tx, 100)
    const neighbors = (await knn(tx, nodeType, nodeId, context.scope)).filter((n) => n.similarity >= config.semanticThreshold)

    // A note purged while it was embedded keeps no edges: the row is locked (FOR SHARE) for the rest of the
    // transaction, after the searches (a long note's searches never hold off writes to it, #452), so a purge
    // either waits for it and then deletes the edges, or ran first and nothing is written.
    if (nodeType === 'note') {
      const live = await tx.execute(sql`SELECT 1 FROM notes WHERE id = ${nodeId} FOR SHARE`)
      if ((live as unknown as unknown[]).length === 0) return
    }

    // Only this node's OWN edges, in one statement: the rows it no longer has go, the others are written. kNN is
    // asymmetric — B can hold A in its top-k while A does not hold B — so deleting by either side would wipe an
    // edge B owns (#91); B's rows are B's recompute's to write. The similarities go as the doubles they are
    // (JavaScript writes the shortest text that reads back as the same double).
    await tx.execute(sql`
      WITH next AS (
        SELECT * FROM unnest(${`{${neighbors.map((n) => n.type).join(',')}}`}::semantic_node_type[],
          ${`{${neighbors.map((n) => n.id).join(',')}}`}::uuid[], ${`{${neighbors.map((n) => n.similarity).join(',')}}`}::float8[])
          AS x(type, id, similarity)),
      dropped AS (
        DELETE FROM semantic_edges e WHERE e.node_a_type = ${nodeType} AND e.node_a_id = ${nodeId}
          AND NOT EXISTS (SELECT 1 FROM next WHERE next.type = e.node_b_type AND next.id = e.node_b_id))
      INSERT INTO semantic_edges (node_a_type, node_a_id, node_b_type, node_b_id, similarity)
      SELECT ${nodeType}::semantic_node_type, ${nodeId}::uuid, next.type, next.id, next.similarity FROM next
      ON CONFLICT (node_a_type, node_a_id, node_b_type, node_b_id) DO UPDATE SET similarity = excluded.similarity`)
  })
}

/** A node whose vectors changed, with its tie key. */
interface ChangedNode {
  type: SemanticNodeType
  id: string
  path: string
  container: string
}

/** The node's blocks whose embed key is one of `newKeys` (its vectors new to it), as `vec`. */
function newVectors(node: ChangedNode, newKeys: readonly string[]): SQL {
  return sql`SELECT b.embedding AS vec FROM blocks b
    WHERE b.owner_type = ${node.type} AND b.owner_id = ${node.id} AND b.embed_key = ANY(${`{${newKeys.map((k) => JSON.stringify(k)).join(',')}}`}::text[])
      AND b.embedding IS NOT NULL`
}

/** Candidate `c`'s similarity to the new vectors `vectors`, from its own query vectors, as `d.similarity`. */
function similarityTo(ownerType: SemanticNodeType, vectors: SQL): SQL {
  return sql`CROSS JOIN LATERAL (
      SELECT 1 - min(q.vec <=> v.vec) AS similarity
      FROM (${queryVectors(ownerType, sql`ARRAY[c.id]`)}) q CROSS JOIN (${vectors}) v
    ) d
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS n, min(e.similarity) AS kth FROM semantic_edges e WHERE e.node_a_type = ${ownerType} AND e.node_a_id = c.id
    ) s`
}

/**
 * The nodes of type `ownerType` in `containers` whose top-k node `node` may
 * now enter through its vectors with embed keys `newKeys` (#1007): a superset,
 * which `mergeEntered` decides exactly. The stored top-k of every node is that
 * of the content (`exactNearestOwners`), so a node's top-k changes only if it
 * holds `node` (`refreshSemanticEdges` takes those from the rows) or `node`
 * now beats its K-th, and the new vectors are the only way in. Three steps:
 * 1. per new vector, its WINDOW nearest query-capable blocks (a note's blocks,
 *    of which its query vectors are the first EDGE_QUERY_BLOCKS; a file's
 *    file-level block) in the containers: their owners;
 * 2. a node in none of the windows has a similarity to the new vectors of at
 *    most the nearest window edge (a window short of WINDOW blocks holds every
 *    such block in reach: then there is no such node). When every window is
 *    full and that edge is still above the threshold, such a node may admit
 *    `node` anyway if its own list is weak (an outlier whose nearest node is
 *    this one): every node whose stored K-th similarity (the threshold below
 *    K rows) is at most that edge;
 * 3. each candidate's similarity to the new vectors, from its own query
 *    vectors (one per candidate, in a lateral subquery: never one aggregate
 *    over every candidate × new vector pair, which spills both vectors of each
 *    pair for a long note): kept when it reaches the threshold and, with K
 *    rows, ranks before the last one: a higher similarity than the K-th, or
 *    the same and a tie key before one of the rows of that similarity (only
 *    then are the targets' keys read). So nodes of equal similarities (one
 *    content in many files) do not touch the lists they cannot change.
 */
async function enteredBy(client: DbOrTx, node: ChangedNode, newKeys: readonly string[], ownerType: SemanticNodeType, containers: string): Promise<string[]> {
  const vectors = newVectors(node, newKeys)
  const owners =
    ownerType === 'note'
      ? sql`SELECT id FROM notes WHERE vault_id = ANY(${containers}::uuid[]) AND deleted_at IS NULL`
      : sql`SELECT id FROM repository_files WHERE repository_id = ANY(${containers}::uuid[])`
  // One statement: the windows, their edge, the weak lists when that edge reaches the threshold, then the check.
  const kept = (await client.execute(sql`
    WITH q AS (SELECT row_number() OVER () AS ord, v.vec FROM (${vectors}) v),
    nearest AS (
      SELECT q.ord, w.owner_id, w.distance FROM q
      CROSS JOIN LATERAL (
        SELECT owner_id, embedding <=> q.vec AS distance FROM blocks
        WHERE owner_type = ${sql.raw(`'${ownerType}'`)} AND embedding IS NOT NULL AND container_id = ANY(${containers}::uuid[])
          ${ownerType === 'code' ? sql`AND kind = 'file'` : sql``} AND owner_id <> ${node.id}
        ORDER BY embedding <=> q.vec
        LIMIT ${WINDOW}
      ) w),
    edge AS (
      SELECT CASE WHEN bool_and(n = ${WINDOW}) THEN 1 - min(far) END AS similarity
      FROM (SELECT count(*) AS n, max(distance) AS far FROM nearest GROUP BY ord) f),
    cands AS (
      SELECT owner_id AS id FROM nearest
      UNION
      SELECT o.id FROM edge CROSS JOIN (${owners}) o
      CROSS JOIN LATERAL (
        SELECT count(*) AS n, min(e.similarity) AS kth FROM semantic_edges e WHERE e.node_a_type = ${ownerType} AND e.node_a_id = o.id
      ) s
      WHERE edge.similarity >= ${config.semanticThreshold} AND o.id <> ${node.id}
        AND (s.n < ${config.semanticK} OR s.kth <= edge.similarity))
    SELECT c.id
    FROM cands c
    ${liveOwner(ownerType, sql`c.id`)}
    ${similarityTo(ownerType, vectors)}
    WHERE d.similarity >= ${config.semanticThreshold}
      AND (s.n < ${config.semanticK} OR d.similarity > s.kth
        OR (d.similarity = s.kth AND EXISTS (
          SELECT 1 FROM semantic_edges t
          LEFT JOIN LATERAL (${targetKey(sql`t`)}) k ON true
          WHERE t.node_a_type = ${ownerType} AND t.node_a_id = c.id AND t.similarity = s.kth
            AND (k.path IS NULL OR ${tieKey(node)} < (k.path COLLATE "C", t.node_b_type::text COLLATE "C", k.container COLLATE "C", t.node_b_id)))))`)) as unknown as Array<{
    id: string
  }>
  return kept.map((r) => r.id)
}

/** The path and container name of row `row`'s target (alias), none when the target is gone or in the trash. */
function targetKey(row: SQL): SQL {
  return sql`SELECT n.path, v.name AS container FROM notes n JOIN vaults v ON v.id = n.vault_id
      WHERE ${row}.node_b_type = 'note' AND n.id = ${row}.node_b_id AND n.deleted_at IS NULL
    UNION ALL SELECT f.path, r.name FROM repository_files f JOIN repositories r ON r.id = f.repository_id
      WHERE ${row}.node_b_type = 'code' AND f.id = ${row}.node_b_id`
}

/** `node`'s tie key as an SQL row, compared in byte order as `byRank` does. */
function tieKey(node: ChangedNode): SQL {
  return sql`(${node.path}::text COLLATE "C", ${node.type}::text COLLATE "C", ${node.container}::text COLLATE "C", ${node.id}::uuid)`
}

/** Lists merged per transaction: one advisory lock each, well inside the shared lock table. */
const MERGE_CHUNK = 256

/**
 * Merges `node` into the top-k of the nodes `ids` of type `ownerType` it
 * entered (`enteredBy`; none of them holds it), inside `tx`, under each one's
 * lock, in one statement (#1007). Each list is the true top-k of the content
 * (`exactNearestOwners`), and the new vectors change no other neighbour's
 * similarity, so the new list is the old one plus `node` less its last row,
 * when `node` ranks before that row by `byRank`: a similarity above it, or an
 * equal one and a tie key (path, type, container name, id) before its
 * target's (checked again under the lock). A list whose last row names a
 * node that is gone is left to a recompute: the node after it is unknown
 * here. Returns those ids.
 */
async function mergeEntered(tx: DbOrTx, node: ChangedNode, newKeys: readonly string[], ownerType: SemanticNodeType, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return []
  const vectors = newVectors(node, newKeys)
  const sorted = `{${[...ids].sort().join(',')}}`
  // In one order (notes, then files, each by id), so two merges never wait on each other; a recompute holds one
  // lock and waits on none.
  await tx.execute(sql`
    SELECT count(pg_advisory_xact_lock(hashtextextended('semantic_edges:' || ${ownerType}::text || ':' || x.id::text, 0)))
    FROM (SELECT id FROM unnest(${sorted}::uuid[]) AS u(id) ORDER BY id) x`)
  const stale = (await tx.execute(sql`
    WITH cand AS (
      SELECT c.id, d.similarity, s.n, s.kth
      FROM unnest(${sorted}::uuid[]) AS c(id)
      ${liveOwner(ownerType, sql`c.id`)}
      ${similarityTo(ownerType, vectors)}
      WHERE d.similarity >= ${config.semanticThreshold} AND (s.n < ${config.semanticK} OR d.similarity >= s.kth)),
    ranked AS (
      SELECT cand.*, w.type AS w_type, w.id AS w_id, coalesce(w.gone, false) AS gone, w.path AS w_path, w.container AS w_container
      FROM cand
      LEFT JOIN LATERAL (
        SELECT t.node_b_type AS type, t.node_b_id AS id, k.path IS NULL AS gone, k.path, k.container
        FROM semantic_edges t
        LEFT JOIN LATERAL (${targetKey(sql`t`)}) k ON true
        WHERE cand.n >= ${config.semanticK} AND t.node_a_type = ${ownerType} AND t.node_a_id = cand.id AND t.similarity = cand.kth
        ORDER BY k.path IS NULL DESC, k.path COLLATE "C" DESC, t.node_b_type::text COLLATE "C" DESC, k.container COLLATE "C" DESC, t.node_b_id DESC
        LIMIT 1
      ) w ON true),
    entering AS (
      SELECT * FROM ranked
      WHERE n < ${config.semanticK}
        OR (NOT gone AND (similarity > kth
          OR (similarity = kth AND ${tieKey(node)} < (w_path COLLATE "C", w_type::text COLLATE "C", w_container COLLATE "C", w_id))))),
    dropped AS (
      DELETE FROM semantic_edges e USING entering x
      WHERE x.n >= ${config.semanticK} AND e.node_a_type = ${ownerType} AND e.node_a_id = x.id AND e.node_b_type = x.w_type AND e.node_b_id = x.w_id),
    added AS (
      INSERT INTO semantic_edges (node_a_type, node_a_id, node_b_type, node_b_id, similarity)
      SELECT ${ownerType}::semantic_node_type, x.id, ${node.type}::semantic_node_type, ${node.id}::uuid, x.similarity FROM entering x
      ON CONFLICT (node_a_type, node_a_id, node_b_type, node_b_id) DO UPDATE SET similarity = excluded.similarity)
    SELECT id FROM ranked WHERE n >= ${config.semanticK} AND gone`)) as unknown as Array<{ id: string }>
  return stale.map((r) => r.id)
}

/**
 * After a node's vectors changed (#1007): the stored semantic edges are a
 * function of the content, not of the order it was embedded in. Recomputes
 * the node's own top-k and that of every node holding it (its vectors moved,
 * so their similarity to it did), and merges it into the lists it now enters
 * through `newKeys`, the embed keys of the vectors it did not have before
 * (`enteredBy`, `mergeEntered`: one statement for up to MERGE_CHUNK of them,
 * e.g. nodes of one content, in the transaction that found them). Each
 * recompute reads the stored blocks, so the order of the steps does not
 * matter. Measured in the PR for #1007.
 */
export async function refreshSemanticEdges(nodeType: SemanticNodeType, nodeId: string, newKeys: readonly string[]): Promise<void> {
  await recomputeSemanticEdges(nodeType, nodeId)
  const later: Array<[SemanticNodeType, string[]]> = []
  const { node, holders, stale } = await db.transaction(async (tx): Promise<{ node: ChangedNode | null; holders: string[]; stale: string[] }> => {
    const context = await nodeContext(tx, nodeType, nodeId, { holders: true })
    if (!context) return { node: null, holders: [], stale: [] }
    const held = new Set(context.holders)
    const stale: string[] = []
    const node: ChangedNode = { type: nodeType, id: nodeId, path: context.path, container: context.container }
    if (context.live && newKeys.length > 0) {
      await setHnswScan(tx, 100)
      for (const type of ['note', 'code'] as const) {
        if (context.scope[type] === '{}') continue
        const entered = (await enteredBy(tx, node, newKeys, type, context.scope[type])).filter((id) => !held.has(`${type}:${id}`))
        for (const id of await mergeEntered(tx, node, newKeys, type, entered.slice(0, MERGE_CHUNK))) stale.push(`${type}:${id}`)
        for (let i = MERGE_CHUNK; i < entered.length; i += MERGE_CHUNK) later.push([type, entered.slice(i, i + MERGE_CHUNK)])
      }
    }
    return { node, holders: context.holders, stale }
  })
  for (const [type, chunk] of later) {
    for (const id of await db.transaction((tx) => mergeEntered(tx, node!, newKeys, type, chunk))) stale.push(`${type}:${id}`)
  }
  for (const key of [...new Set([...holders, ...stale])].sort()) {
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
 * Durable jobs (`jobs/durable.ts`) of kind `semantic_edges`, monitoring job kind `semantic-edges`:
 * - the rebuild (#1007): payload `{nodeType, nodeId}`, key `semantic_edges:<type>:<id>`, each recomputing
 *   one node's top-k from its stored blocks (`recomputeSemanticEdges`). Once every node has run, the stored
 *   edges are those of the content whatever order it was embedded in. Queued for every node by
 *   `pnpm reindex` and, once, by migration 0046;
 * - a refresh (`queueSemanticEdgeRefresh`): payload `{nodeType, nodeId, newKeys}`, no key, runs
 *   `refreshSemanticEdges`.
 */
export const SEMANTIC_EDGES_JOB = 'semantic_edges'

interface EdgeJob {
  nodeType: SemanticNodeType
  nodeId: string
  newKeys?: string[]
}

async function drainEdgeJobs(): Promise<void> {
  await failCrashedJobs(SEMANTIC_EDGES_JOB, 'semantic-edges', 'nodeId')
  for (;;) {
    const job = await claimJob<EdgeJob>(SEMANTIC_EDGES_JOB)
    if (!job) return
    const { nodeType, nodeId, newKeys } = job.payload
    try {
      if (newKeys) await refreshSemanticEdges(nodeType, nodeId, newKeys)
      else await recomputeSemanticEdges(nodeType, nodeId)
      await completeJob(job.id)
      recordJob('semantic-edges', 'ok', nodeId)
    } catch (err) {
      const gaveUp = await failJob(job, err, 'semantic-edges', nodeId)
      console.warn(`[semantic-edges] ${nodeType} ${nodeId} (attempt ${job.attempts}/${MAX_JOB_ATTEMPTS}${gaveUp ? ', gave up' : ''}):`, err)
    }
  }
}

const edgeJobs = jobDrainer('semantic-edges', drainEdgeJobs)

/**
 * Inside the transaction of a write that embedded or dropped vectors of a node: its refresh as a job the
 * caller holds (its lease runs, so no worker claims it meanwhile), to run with `runSemanticEdgeRefresh`
 * once the write committed. A refresh that fails there (a database error after the commit) is not lost:
 * the lease runs out and the worker runs the job, with the usual retries. The job's priority is a
 * write's. Returns its id.
 */
export async function queueSemanticEdgeRefresh(
  tx: DbOrTx,
  nodeType: SemanticNodeType,
  nodeId: string,
  newKeys: readonly string[],
): Promise<number> {
  const payload: EdgeJob = { nodeType, nodeId, newKeys: [...newKeys] }
  const [row] = (await tx.execute(sql`
    INSERT INTO jobs (kind, payload, priority, lease_until)
    VALUES (${SEMANTIC_EDGES_JOB}, ${JSON.stringify(payload)}::jsonb, ${JOB_PRIORITY.write}::smallint,
      now() + ${jobTiming.leaseMs} * interval '1 millisecond')
    RETURNING id`)) as unknown as Array<{ id: string | number }>
  return Number(row!.id)
}

/** After the commit: runs the refresh `queueSemanticEdgeRefresh` queued as job `jobId`, and completes it. */
export async function runSemanticEdgeRefresh(jobId: number, nodeType: SemanticNodeType, nodeId: string, newKeys: readonly string[]): Promise<void> {
  try {
    await refreshSemanticEdges(nodeType, nodeId, newKeys)
    await completeJob(jobId)
  } catch (err) {
    console.warn(`[semantic-edges] refresh of ${nodeType} ${nodeId} failed; job ${jobId} runs again when its lease ends:`, err)
  }
}

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

/** Drains the `semantic_edges` jobs and awaits the drain: batch scripts and tests only. */
export async function runSemanticEdgeRebuild(): Promise<void> {
  edgeJobs.kick()
  await edgeJobs.flush()
}
