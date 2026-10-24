import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { blocks } from '../db/schema.js'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type BlockRow = typeof blocks.$inferInsert

/**
 * Rows per INSERT: one statement binds at most 65,534 parameters
 * (postgres.js), and a block row has 15, so a generated file with thousands
 * of constants would fail whole (#450 review). Every chunk is in the same
 * transaction, so the owner still commits all or nothing.
 */
const INSERT_CHUNK_ROWS = 1_000

export function* chunks<T>(rows: readonly T[]): Generator<T[]> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK_ROWS) yield rows.slice(i, i + INSERT_CHUNK_ROWS)
}

/**
 * The vectors an owner's blocks already have, by `embed_key` (ADR-004 §2.5
 * reuse): a block of the new set with the same key keeps that vector
 * instead of being embedded again.
 */
export async function vectorsByEmbedKey(ownerType: 'note' | 'code', ownerId: string): Promise<Map<string, number[]>> {
  const kept = new Map<string, number[]>()
  for (const b of await db
    .select({ embedKey: blocks.embedKey, embedding: blocks.embedding })
    .from(blocks)
    .where(and(eq(blocks.ownerType, ownerType), eq(blocks.ownerId, ownerId)))) {
    if (b.embedKey && b.embedding) kept.set(b.embedKey, b.embedding)
  }
  return kept
}

/**
 * Replaces an owner's whole block set inside `tx` (#460): blocks the new set
 * does not have go, the others are upserted by `block_id`, so a block that
 * survives keeps its row. `rows` all belong to `ownerType`/`ownerId`.
 */
export async function replaceBlockSet(tx: Tx, ownerType: 'note' | 'code', ownerId: string, rows: readonly BlockRow[]): Promise<void> {
  await tx.execute(sql`DELETE FROM blocks WHERE owner_type = ${ownerType} AND owner_id = ${ownerId}
    AND block_id <> ALL(${`{${rows.map((b) => b.blockId).join(',')}}`}::text[])`)
  for (const chunk of chunks(rows)) {
    await tx
      .insert(blocks)
      .values(chunk)
      .onConflictDoUpdate({
        target: [blocks.ownerType, blocks.ownerId, blocks.blockId],
        set: {
          containerId: sql`excluded.container_id`,
          kind: sql`excluded.kind`,
          innerPath: sql`excluded.inner_path`,
          symbolKind: sql`excluded.symbol_kind`,
          symbolParent: sql`excluded.symbol_parent`,
          snippet: sql`excluded.snippet`,
          startLine: sql`excluded.start_line`,
          endLine: sql`excluded.end_line`,
          contentHash: sql`excluded.content_hash`,
          ownerVersion: sql`excluded.owner_version`,
          embedKey: sql`excluded.embed_key`,
          embedding: sql`excluded.embedding`,
        },
      })
  }
}
