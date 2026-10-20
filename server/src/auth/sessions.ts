import { and, eq, gt, ne } from 'drizzle-orm'
import { db } from '../db/client.js'
import { sessions, users } from '../db/schema.js'
import { generateToken, hashToken } from './tokens.js'
import { emitPermissionChange } from '../sync/permission-events.js'

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

export type SessionUser = typeof users.$inferSelect

export async function createSession(userId: string): Promise<string> {
  const token = generateToken()
  await db.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  })
  return token
}

/** Resolves a session token to its user, or null. Only active users resolve. */
export async function getSessionUser(token: string): Promise<SessionUser | null> {
  const rows = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        gt(sessions.expiresAt, new Date()),
        eq(users.status, 'active'),
      ),
    )
    .limit(1)
  return rows[0]?.user ?? null
}

/** True while the session with this token hash exists and has not expired. */
export async function sessionActive(tokenHash: string): Promise<boolean> {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())))
    .limit(1)
  return rows.length > 0
}

/**
 * Ending a session closes every live connection it opened (#498): the collab
 * relay and the live-view hub hear of it through `sessionHashes`. Every path
 * that deletes session rows announces them once the delete is committed.
 */
export async function destroySession(token: string): Promise<void> {
  const ended = await db
    .delete(sessions)
    .where(eq(sessions.tokenHash, hashToken(token)))
    .returning({ tokenHash: sessions.tokenHash })
  if (ended.length > 0) emitPermissionChange({ sessionHashes: ended.map((s) => s.tokenHash) })
}

/**
 * Kills every session for a user (logout-everywhere, password change,
 * deactivation). `exceptToken` spares one — a self-service password change
 * signs out the other devices without signing out the device doing it.
 */
export async function destroyUserSessions(
  userId: string,
  exceptToken?: string,
): Promise<void> {
  const ended = await db
    .delete(sessions)
    .where(
      exceptToken
        ? and(eq(sessions.userId, userId), ne(sessions.tokenHash, hashToken(exceptToken)))
        : eq(sessions.userId, userId),
    )
    .returning({ tokenHash: sessions.tokenHash })
  if (ended.length > 0) emitPermissionChange({ sessionHashes: ended.map((s) => s.tokenHash) })
}
