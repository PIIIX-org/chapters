import { apiFetch } from '../lib/api.js'

/**
 * Short-lived credential for the collaboration websocket.
 *
 * The session cookie is `httpOnly`, so the browser cannot read it and cannot
 * hand it to `HocuspocusProvider`'s `token` option the way the server tests do.
 * The client asks for a ticket instead: opaque, single-use, seconds-long TTL,
 * bound to the calling user. `url` comes back with it as a PATH — the relay
 * rides the API's own HTTP server on `/collab`, so there is no second port,
 * and the server cannot know which origin the browser used anyway.
 */
export interface CollabTicket {
  /** Opaque one-time credential passed as the Hocuspocus `token`. */
  token: string
  /**
   * The relay's PATH on this origin (`/collab`), not an absolute URL.
   *
   * The server cannot know the origin the browser used — behind vite in dev
   * and nginx in production it sees the proxy's host, and handing that back
   * produced `ws://localhost:3000/collab`, the API port, which has no relay
   * and 404s the handshake. Resolve it with `collabSocketUrl()`.
   */
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

/**
 * Resolves a ticket's relay path against the page's own origin, swapping
 * http(s) for ws(s). The origin the page loaded from is the one that is
 * guaranteed to reach back through whatever proxy served it.
 */
export function collabSocketUrl(path: string, origin: string): string {
  const url = new URL(path, origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString().replace(/\/$/, '')
}
