import { apiFetch } from '../lib/api.js'

/**
 * Short-lived credential for the collaboration websocket.
 *
 * The session cookie is `httpOnly`, so the browser cannot read it and cannot
 * hand it to `HocuspocusProvider`'s `token` option the way the server tests do.
 * The client asks for a ticket instead: opaque, single-use, seconds-long TTL,
 * bound to the calling user. `url` comes back with it because the relay listens
 * on its own port (`COLLAB_PORT`, default 3001) and nothing else tells the
 * client where that is.
 *
 * Backend gap 1 + 2 — see the unit 6 plan. This module is the contract the
 * endpoint must satisfy.
 */
export interface CollabTicket {
  /** Opaque one-time credential passed as the Hocuspocus `token`. */
  token: string
  /** Absolute `ws://` / `wss://` URL of the relay. */
  url: string
  /** ISO timestamp; a ticket is useless after it, so never cache one. */
  expiresAt: string
}

export function getCollabTicket(): Promise<CollabTicket> {
  return apiFetch<CollabTicket>('/collab/ticket', { method: 'POST' })
}

/**
 * The document name the relay parses (`parseDocName` in
 * `server/src/sync/collab-server.ts`): everything before the first slash is the
 * vault id, the rest is the note path.
 */
export function collabDocName(vaultId: string, path: string): string {
  return `${vaultId}/${path}`
}

/** A note's content as the SSE live-view stream sends it. */
export interface LiveNoteState {
  frontmatter: Record<string, unknown>
  body: string
}

/**
 * SSE endpoint for read-only live viewers (`server/src/sync/routes.ts`).
 * Read-only users never join the Yjs doc — that is the audit's presence rule
 * enforced structurally, not a UI decision — so they get content states only:
 * no awareness, no identities, no cursors.
 */
export function liveNoteUrl(vaultId: string, path: string): string {
  return `/api/vaults/${vaultId}/live/${path}`
}
