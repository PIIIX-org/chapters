import { and, eq, gte, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { noteReads } from '../db/schema.js'

/**
 * The `rev` each MCP connection last read of each note (#408, #476).
 * read_note and export_note record it; an edit_note `body` sent without
 * `base_rev` is three-way merged against it as if it were the `base_rev`, so
 * an agent that sends back the whole body it read (plus its change) never
 * removes what a person typed after the read. A whole body applied exactly
 * as sent moves it to the result's `rev`, which is then what the agent knows.
 *
 * Kept in `note_reads` (migration 0028), so a server restart between the
 * read and the edit keeps it, for READ_WINDOW_HOURS: rows older than that
 * are pruned on every read, and an older read is no base. Deleting the
 * connection or purging the note deletes its rows. With no read on record,
 * an edit without `base_rev` is a diff from the live text, as before.
 */
export const READ_WINDOW_HOURS = 24

const inWindow = gte(noteReads.readAt, sql`now() - make_interval(hours => ${READ_WINDOW_HOURS})`)

/** `connectionId` read note `noteId` at `rev`: one statement that also prunes reads past the window. */
export async function rememberRead(connectionId: string, noteId: string, rev: number): Promise<void> {
  await db.execute(sql`
    WITH pruned AS (DELETE FROM note_reads WHERE read_at < now() - make_interval(hours => ${READ_WINDOW_HOURS}))
    INSERT INTO note_reads (connection_id, note_id, rev) VALUES (${connectionId}, ${noteId}, ${rev})
    ON CONFLICT (connection_id, note_id) DO UPDATE SET rev = EXCLUDED.rev, read_at = now()`)
}

/** `connectionId` wrote note `noteId` to `rev` exactly as it sent it: its new last read, if it has one in the window. */
export async function advanceRead(connectionId: string, noteId: string, rev: number): Promise<void> {
  await db
    .update(noteReads)
    .set({ rev, readAt: sql`now()` })
    .where(and(eq(noteReads.connectionId, connectionId), eq(noteReads.noteId, noteId), inWindow))
}

/** The `rev` of `connectionId`'s last read of note `noteId` within the window, if one is on record. */
export async function lastRead(connectionId: string, noteId: string): Promise<number | undefined> {
  const [row] = await db
    .select({ rev: noteReads.rev })
    .from(noteReads)
    .where(and(eq(noteReads.connectionId, connectionId), eq(noteReads.noteId, noteId), inWindow))
  return row?.rev
}
