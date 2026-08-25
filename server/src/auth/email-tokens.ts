import { and, eq, gt, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { emailTokens } from '../db/schema.js'
import { hashToken } from './tokens.js'

const TTL_MS = 30 * 60 * 1000

type Purpose = 'verify_email' | 'password_reset'

/**
 * Issues a token, superseding every outstanding one of the same purpose for
 * that user.
 *
 * The superseding half is load-bearing, not tidiness. A token is bound to a
 * *user*, not to the address it was mailed to — so without it, changing your
 * email twice inside the TTL leaves the first code live and usable against the
 * second address: request a change to an address you control, keep that code,
 * change again to someone else's address, and submit the first code. The
 * account ends up verified under an address that never received mail. Binding
 * tokens to an address would need a column; making a new code kill the old one
 * closes it outright, and "the latest code is the only one that works" is what
 * a person already expects.
 */
export async function createEmailToken(
  userId: string,
  purpose: Purpose,
  raw: string,
): Promise<void> {
  await db
    .update(emailTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(emailTokens.userId, userId),
        eq(emailTokens.purpose, purpose),
        isNull(emailTokens.usedAt),
      ),
    )
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
