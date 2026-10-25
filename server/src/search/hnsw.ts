import { sql } from 'drizzle-orm'
import type { db } from '../db/client.js'

/** A transaction of `db.transaction`. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Sets the HNSW search of the rest of transaction `tx` (#462, #461): its
 * width `hnsw.ef_search` (HNSW returns at most that many rows) and, on
 * pgvector 0.8.0 or later, the iterative scan (`relaxed_order`): when the
 * query's WHERE (scope, kind) drops most of the instance's nearest rows, the
 * scan goes on, up to `hnsw.max_scan_tuples` (20,000 by default), instead of
 * answering short. Relaxed order can return rows slightly out of distance
 * order, so a caller re-sorts what it keeps. An older pgvector refuses the
 * setting (it reserves the `hnsw.` prefix), so it is set only when the
 * installed version has it. One statement, `SET LOCAL` semantics.
 */
export async function setHnswScan(tx: Tx, efSearch: number): Promise<void> {
  await tx.execute(sql`
    SELECT set_config('hnsw.ef_search', ${String(efSearch)}, true),
           CASE WHEN string_to_array(extversion, '.')::int[] >= '{0,8,0}' THEN set_config('hnsw.iterative_scan', 'relaxed_order', true) END
    FROM pg_extension WHERE extname = 'vector'`)
}
