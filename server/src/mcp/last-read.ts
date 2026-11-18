import { and, eq, gte, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { noteReads } from '../db/schema.js'
import { storeTransaction } from '../notes/store-tx.js'

/** Read-derived implicit edit bases, retained for 24 h. Blind writes must not create a base. */
export const READ_WINDOW_HOURS = 24
const inWindow = gte(noteReads.readAt, sql`now() - make_interval(hours => ${READ_WINDOW_HOURS})`)

/**
 * The epoch belongs to the originating read/write, not to a later lookup of its current revision.
 * Purge shares this database note mutex and increments the epoch in its deletion transaction.
 * Thus a delayed writer cannot put plaintext back after a purge, even when the current seq survives.
 */
async function retainRead(
  connectionId: string,
  noteId: string,
  rev: number,
  purgeEpoch: number,
  sent: string | null,
  mode: 'remember' | 'confirm' | 'advance',
): Promise<void> {
  await storeTransaction([noteId], async (tx) => {
    const valid = await tx.execute(sql`
      SELECT n.id FROM notes n JOIN vaults v ON v.id = n.vault_id
      WHERE n.id = ${noteId} AND n.deleted_at IS NULL AND v.deleted_at IS NULL
        AND n.purge_epoch = ${purgeEpoch}
        AND EXISTS (SELECT 1 FROM note_revisions r WHERE r.note_id = n.id AND r.seq = ${rev})`)
    if (valid.length === 0) return
    await tx.execute(sql`DELETE FROM note_reads WHERE read_at < now() - make_interval(hours => ${READ_WINDOW_HOURS})`)
    if (mode === 'advance') {
      await tx.update(noteReads).set({ rev, body: sent, readAt: sql`now()` })
        .where(and(eq(noteReads.connectionId, connectionId), eq(noteReads.noteId, noteId), inWindow))
    } else if (mode === 'confirm') {
      await tx.execute(sql`
        INSERT INTO note_reads (connection_id, note_id, rev, body) VALUES (${connectionId}, ${noteId}, ${rev}, NULL)
        ON CONFLICT (connection_id, note_id) DO UPDATE
          SET body = CASE WHEN note_reads.rev = EXCLUDED.rev THEN note_reads.body END, rev = EXCLUDED.rev, read_at = now()`)
    } else {
      await tx.execute(sql`
        INSERT INTO note_reads (connection_id, note_id, rev, body) VALUES (${connectionId}, ${noteId}, ${rev}, ${sent})
        ON CONFLICT (connection_id, note_id) DO UPDATE SET rev = EXCLUDED.rev, body = EXCLUDED.body, read_at = now()`)
    }
  })
}

/** Remember an actual read/create, only if its exact identity, revision and purge generation remain valid. */
export function rememberRead(connectionId: string, noteId: string, rev: number, purgeEpoch: number, sent: string | null = null): Promise<void> {
  return retainRead(connectionId, noteId, rev, purgeEpoch, sent, 'remember')
}

/** An observed identity can come from a read or an exact successful audit revision, without inventing an edit base. */
export async function hasObservedNote(connectionId: string, noteId: string, rev: number): Promise<boolean> {
  const [row] = (await db.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM note_reads WHERE connection_id = ${connectionId} AND note_id = ${noteId}
        AND read_at >= now() - make_interval(hours => ${READ_WINDOW_HOURS})
    ) OR EXISTS (
      SELECT 1 FROM note_revisions WHERE note_id = ${noteId} AND seq = ${rev}
        AND actor_type = 'mcp' AND actor_id = ${connectionId}
        AND created_at >= now() - make_interval(hours => ${READ_WINDOW_HOURS})
    ) AS observed`)) as unknown as Array<{ observed: boolean }>
  return row!.observed
}

/** A conditional read preserves a same-revision sent body only under the shared purge boundary. */
export function confirmRead(connectionId: string, noteId: string, rev: number, purgeEpoch: number): Promise<void> {
  return retainRead(connectionId, noteId, rev, purgeEpoch, null, 'confirm')
}

/** Advance an existing read-derived base; a blind write must not create one. */
export function advanceRead(connectionId: string, noteId: string, rev: number, purgeEpoch: number, sent: string | null): Promise<void> {
  return retainRead(connectionId, noteId, rev, purgeEpoch, sent, 'advance')
}

/** The base's revision and, after a merge, the caller's sent body rather than the merged revision's body. */
export async function lastRead(connectionId: string, noteId: string): Promise<{ rev: number; body: string | null } | undefined> {
  const [row] = await db.select({ rev: noteReads.rev, body: noteReads.body }).from(noteReads)
    .where(and(eq(noteReads.connectionId, connectionId), eq(noteReads.noteId, noteId), inWindow))
  return row
}
