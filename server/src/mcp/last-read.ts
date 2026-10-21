/**
 * The `rev` each MCP connection last read of each note (#408, #476).
 * read_note and export_note record it; an edit_note `body` sent without
 * `base_rev` is three-way merged against it as if it were the `base_rev`, so
 * an agent that sends back the whole body it read (plus its change) never
 * removes what a person typed after the read. A whole body applied exactly
 * as sent moves it to the result's `rev`, which is then what the agent knows.
 *
 * Kept in memory (one server process per instance, ADR-003 §1.6) for the
 * newest MAX_ENTRIES (connection, note) pairs: after a restart, or for a
 * connection that never read the note, an edit without `base_rev` is a diff
 * from the live text, as before.
 */
const MAX_ENTRIES = 50_000
const reads = new Map<string, number>()

const key = (connectionId: string, noteId: string): string => `${connectionId}/${noteId}`

/** `connectionId` read note `noteId` at `rev`. */
export function rememberRead(connectionId: string, noteId: string, rev: number): void {
  const k = key(connectionId, noteId)
  reads.delete(k)
  reads.set(k, rev)
  if (reads.size > MAX_ENTRIES) reads.delete(reads.keys().next().value!)
}

/** `connectionId` wrote note `noteId` to `rev` exactly as it sent it: its new last read, if it has one. */
export function advanceRead(connectionId: string, noteId: string, rev: number): void {
  if (reads.has(key(connectionId, noteId))) rememberRead(connectionId, noteId, rev)
}

/** The `rev` of `connectionId`'s last read of note `noteId`, if one is on record. */
export function lastRead(connectionId: string, noteId: string): number | undefined {
  return reads.get(key(connectionId, noteId))
}
