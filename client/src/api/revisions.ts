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
  action: string
  createdAt: string
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
