import { and, eq, gte, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { noteReads } from '../db/schema.js'

/**
 * What each MCP connection last had of each note (#408, #476): the `rev` of
 * its last read_note or export_note, the base an edit_note `body` sent
 * without `base_rev` is three-way merged from as if it were the `base_rev`,
 * so an agent that sends back the whole body it read (plus its change)
 * never removes what a person typed after the read.
 *
 * After a whole body of its is written, the base moves to that write's
 * `rev`, with the body the agent sent when the write was merged with
 * changes made since (the revision then holds more than the agent has):
 * the agent's next body is built on what it sent, so its earlier lines are
 * not its change a second time (a second append would otherwise repeat the
 * first one after lines others added since).
 *
 * Kept in `note_reads` (migration 0028), so a server restart between the
 * read and the edit keeps it, for READ_WINDOW_HOURS: rows older than that
 * are pruned on every read, and an older read is no base. Deleting the
 * connection or purging the note deletes its rows. With no read on record,
 * an edit without `base_rev` is a diff from the live text, as before.
 */
export const READ_WINDOW_HOURS = 24

const inWindow = gte(noteReads.readAt, sql`now() - make_interval(hours => ${READ_WINDOW_HOURS})`)

/**
 * `connectionId` read note `noteId` at `rev` (or created it there, `sent`
 * being the body it sent when the stored one differs): one statement that
 * also prunes reads past the window.
 */
export async function rememberRead(connectionId: string, noteId: string, rev: number, sent: string | null = null): Promise<void> {
  await db.execute(sql`
    WITH pruned AS (DELETE FROM note_reads WHERE read_at < now() - make_interval(hours => ${READ_WINDOW_HOURS}))
    INSERT INTO note_reads (connection_id, note_id, rev, body) VALUES (${connectionId}, ${noteId}, ${rev}, ${sent})
    ON CONFLICT (connection_id, note_id) DO UPDATE SET rev = EXCLUDED.rev, body = EXCLUDED.body, read_at = now()`)
}

/**
 * `connectionId` wrote note `noteId` to `rev` with a whole body: its new
 * base, if it has one in the window. `sent` is the body it sent when the
 * result differs from it (merged), null when the revision holds it.
 */
export async function advanceRead(connectionId: string, noteId: string, rev: number, sent: string | null): Promise<void> {
  await db
    .update(noteReads)
    .set({ rev, body: sent, readAt: sql`now()` })
    .where(and(eq(noteReads.connectionId, connectionId), eq(noteReads.noteId, noteId), inWindow))
}

/** `connectionId`'s base of note `noteId` within the window, if one is on record: the `rev`, and the body it sent when that is not the revision's. */
export async function lastRead(connectionId: string, noteId: string): Promise<{ rev: number; body: string | null } | undefined> {
  const [row] = await db
    .select({ rev: noteReads.rev, body: noteReads.body })
    .from(noteReads)
    .where(and(eq(noteReads.connectionId, connectionId), eq(noteReads.noteId, noteId), inWindow))
  return row
}

/**
 * `connectionId` read note `noteId` only in part (a paged `read_note`, #420): an earlier read is no base any
 * more, since what the connection now has is newer and not whole, so its next whole-body edit diffs from the
 * live text instead of merging from that older read.
 */
export async function forgetRead(connectionId: string, noteId: string): Promise<void> {
  await db.delete(noteReads).where(and(eq(noteReads.connectionId, connectionId), eq(noteReads.noteId, noteId)))
}
