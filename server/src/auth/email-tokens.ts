import { and, eq, gt, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { emailTokens } from '../db/schema.js'
import { hashToken } from './tokens.js'

const TTL_MS = 30 * 60 * 1000

type Purpose = 'verify_email' | 'password_reset'

export async function createEmailToken(
  userId: string,
  purpose: Purpose,
  raw: string,
): Promise<void> {
  await db.insert(emailTokens).values({
    userId,
    purpose,
    tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + TTL_MS),
  })
}

/**
 * Consumes a matching unused, unexpired token. Single-use: marks it used
 * atomically and returns the owning userId, or null if invalid.
 */
export async function consumeEmailToken(
  purpose: Purpose,
  raw: string,
  userId?: string,
): Promise<string | null> {
  const conditions = [
    eq(emailTokens.purpose, purpose),
    eq(emailTokens.tokenHash, hashToken(raw)),
    isNull(emailTokens.usedAt),
    gt(emailTokens.expiresAt, new Date()),
  ]
  if (userId) conditions.push(eq(emailTokens.userId, userId))
  const updated = await db
    .update(emailTokens)
    .set({ usedAt: new Date() })
    .where(and(...conditions))
    .returning({ userId: emailTokens.userId })
  return updated[0]?.userId ?? null
}
