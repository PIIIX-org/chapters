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
  /** The largest note body the relay stores, in UTF-8 bytes (server
   *  ELARA_NOTE_MAX_BYTES, #491): how much a refused note has to lose. */
  maxNoteBytes: number
  /** The largest websocket frame the relay reads, in bytes: a sync bigger
   *  than this is closed (1009) before the size cap is even checked. */
  maxFrameBytes: number
}

export function getCollabTicket(): Promise<CollabTicket> {
  return apiFetch<CollabTicket>('/collab/ticket', { method: 'POST' })
}

/**
 * The document name the relay parses (`parseDocName` in
 * `server/src/sync/live-docs.ts`): `<vaultId>/~<noteId>`. Named by note id
 * (ADR-003 §5.4), so a rename keeps the editor connected and a tab can never
 * reach another note created later at the same path.
 */
export function collabDocName(vaultId: string, noteId: string): string {
  return `${vaultId}/~${noteId}`
}

/**
 * The path-keyed name bundles before ADR-003 S2b used. The relay refuses it;
 * it is kept only to find this browser's copies (#720) stored under it, until
 * none is left.
 */
export function legacyCollabDocName(vaultId: string, path: string): string {
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
