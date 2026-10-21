import { apiFetch } from '../lib/api.js'

/**
 * Revision history is **metadata only**: who changed a note, when, and how.
 * Reverting needs a `revisionId` and nothing else, so no body is fetched —
 * which is also what keeps this list bounded on a note with years of edits.
 */
export interface Revision {
  id: string
  /**
   * Exactly the `actor_type` pg enum (schema.ts) — there is no 'system'.
   * 'collab' is the default actor for every write that does not name one,
   * including every realtime co-editing save, so it is the value this list
   * carries most often. It means a **person** edited through the collab
   * relay, so it is vermillion like 'user', never teal.
   */
  actorType: 'user' | 'mcp' | 'collab'
  actorId: string | null
  /** History list only: the MCP connection's name when an agent recorded this revision; null otherwise or once the connection is deleted. */
  actorName?: string | null
  /**
   * create, update, delete, restore, rename, revert, quarantine,
   * restore_point (the note as it was before an agent's first write in a
   * session, #482), or proposal (an agent's edit kept out of the note
   * because it overlapped changes made since the agent read it, #475). A
   * newer one is shown as is.
   */
  action: string
  createdAt: string
  /** A `revert` row: the revision it brought back (#479); a `proposal` row: the revision it was made from (#475). */
  sourceRevisionId?: string
  /** A `rename` row: the note's path before and after (#479). */
  fromPath?: string
  toPath?: string
}

/** Newest first. Requires **edit** access, not merely read (audit rule). */
export function listRevisions(
  vaultId: string,
  path: string,
  limit = 50,
  offset = 0,
): Promise<Revision[]> {
  return apiFetch(`/vaults/${vaultId}/history/${path}?limit=${limit}&offset=${offset}`)
}

/** Recorded as a new attributed write, not a rewrite of history. */
export function revertNote(
  vaultId: string,
  path: string,
  revisionId: string,
): Promise<{ id: string; path: string }> {
  return apiFetch(`/vaults/${vaultId}/revert/${path}`, {
    method: 'POST',
    body: JSON.stringify({ revisionId }),
  })
}

/** Hard delete of one recorded revision. Owner or instance admin only. */
export function purgeRevision(vaultId: string, revisionId: string): Promise<{ status: 'purged' }> {
  return apiFetch(`/vaults/${vaultId}/revisions/${revisionId}`, { method: 'DELETE' })
}

export interface RevisionDetail extends Revision {
  noteId: string
  path: string
  frontmatter: Record<string, unknown>
  body: string
}

/** Fetches full content and frontmatter of a single revision for diff preview. */
export function getRevision(vaultId: string, revisionId: string): Promise<RevisionDetail> {
  return apiFetch(`/vaults/${vaultId}/revisions/${revisionId}`)
}
