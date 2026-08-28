import { generateToken, hashToken } from '../auth/tokens.js'

/**
 * Collab tickets (unit 6, backend gaps 1 + 2).
 *
 * The session cookie is `httpOnly`, so browser JS cannot hand a session token
 * to `HocuspocusProvider`'s `token` option the way the Node tests do. A ticket
 * is the credential it can hold: opaque, single-use, seconds long, bound to the
 * user who asked for it. It proves *who* is connecting and nothing else —
 * `onAuthenticate`'s `edit` check and `beforeHandleMessage` still decide what
 * that user may do.
 *
 * Only the SHA-256 hash is stored, same as sessions, MCP connection tokens and
 * export links.
 */
const TTL_MS = 60_000

interface StoredTicket {
  userId: string
  expiresAt: number
}

// ponytail: in-process Map. The relay is in-process on its own port, so a
// second server process could not serve these anyway; if the app ever runs
// multi-instance this becomes a `collab_tickets` table with the same
// (token_hash, user_id, expires_at) shape.
const tickets = new Map<string, StoredTicket>()

export interface IssuedTicket {
  /** The raw credential — returned once, never stored. */
  token: string
  expiresAt: Date
}

export function issueTicket(userId: string, ttlMs = TTL_MS): IssuedTicket {
  const now = Date.now()
  for (const [hash, ticket] of tickets) {
    if (ticket.expiresAt <= now) tickets.delete(hash)
  }
  const token = generateToken()
  const expiresAt = new Date(now + ttlMs)
  tickets.set(hashToken(token), { userId, expiresAt: expiresAt.getTime() })
  return { token, expiresAt }
}

/**
 * Redeems a ticket, returning the user it was minted for. Single use: the
 * ticket is dropped whether or not it was still valid, so a replay of a
 * still-fresh ticket and a replay of an expired one both fail.
 */
export function consumeTicket(token: string): string | null {
  const hash = hashToken(token)
  const ticket = tickets.get(hash)
  if (!ticket) return null
  tickets.delete(hash)
  return ticket.expiresAt > Date.now() ? ticket.userId : null
}
