/**
 * The checks the relay runs on a collab update before it logs and acks it
 * (ADR-003 §5.4 "Append", S3). `beforeSync` gets the raw bytes before
 * Hocuspocus decodes or applies them, so this is where a malformed update
 * is refused and where an update that only repeats what the document
 * already holds is recognised and not logged again.
 */
import * as Y from 'yjs'
import { updateHasContent } from './note-crdt.js'

/**
 * What of `bytes` the relay must log before it applies and acks the update
 * to `live`, or null when `live` already holds all of it (a reconnect's
 * sync step 2 repeating known items). Throws when the bytes do not decode or
 * do not apply to an empty document (§5.4 Append step 1): the cost is
 * proportional to the update, not the note, and the caller refuses the
 * message so nothing is stored.
 */
export function updateToLog(live: Y.Doc, bytes: Uint8Array): Uint8Array | null {
  Y.decodeUpdate(bytes)
  const scratch = new Y.Doc()
  try {
    Y.applyUpdate(scratch, bytes)
  } finally {
    scratch.destroy()
  }
  if (Y.snapshotContainsUpdate(Y.snapshot(live), bytes)) return null
  // Only what `live` lacks: diffUpdate alone keeps the whole delete set, so the skip above comes first.
  const diff = Y.diffUpdate(bytes, Y.encodeStateVector(live))
  return updateHasContent(diff) ? diff : null
}

/**
 * Whether `live` took a logged update (§5.4 Append step 5): every struct it
 * carries is integrated, or Yjs holds it as pending until the structs it
 * depends on arrive. False means the live apply threw part-way.
 */
export function liveTookUpdate(live: Y.Doc, update: Uint8Array): boolean {
  if (live.store.pendingStructs || live.store.pendingDs) return true
  const have = Y.decodeStateVector(Y.encodeStateVector(live))
  for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVectorFromUpdate(update))) {
    if ((have.get(client) ?? 0) < clock) return false
  }
  return true
}
