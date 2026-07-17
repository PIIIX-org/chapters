import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { instanceState } from '../db/schema.js'
import { config } from '../config.js'
import { generateToken, hashToken } from './tokens.js'

/**
 * Ensures the one-time setup token exists (spec: bootstrap is claimed with
 * an out-of-band token, never "first to sign up wins"). Returns the raw
 * token when setup is still pending so the caller can print it to the
 * deploy log — the only place it ever appears in plaintext.
 */
export async function ensureInstanceState(): Promise<{
  setupPending: boolean
  setupToken?: string
}> {
  const rows = await db.select().from(instanceState).limit(1)
  const state = rows[0]
  if (state?.setupCompletedAt) return { setupPending: false }
  if (state?.setupTokenHash && !config.setupToken) {
    // Token already generated on a previous boot and not overridden.
    return { setupPending: true }
  }
  const token = config.setupToken ?? generateToken()
  const tokenHash = hashToken(token)
  if (state) {
    await db
      .update(instanceState)
      .set({ setupTokenHash: tokenHash })
      .where(eq(instanceState.id, 'singleton'))
  } else {
    await db.insert(instanceState).values({ setupTokenHash: tokenHash })
  }
  return { setupPending: true, setupToken: token }
}

export async function isSetupComplete(): Promise<boolean> {
  const rows = await db.select().from(instanceState).limit(1)
  return Boolean(rows[0]?.setupCompletedAt)
}
