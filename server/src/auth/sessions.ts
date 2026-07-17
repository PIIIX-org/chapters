import { and, eq, gt } from 'drizzle-orm'
import { db } from '../db/client.js'
import { sessions, users } from '../db/schema.js'
import { generateToken, hashToken } from './tokens.js'

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

export async function destroySession(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)))
}

/** Kills every session for a user (logout-everywhere, password change, deactivation). */
export async function destroyUserSessions(userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId))
}
