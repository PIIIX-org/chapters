import { randomBytes } from 'node:crypto'
import * as OTPAuth from 'otpauth'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { instanceState, mfaBackupCodes, users } from '../db/schema.js'
import { hashToken } from './tokens.js'

const BACKUP_CODE_COUNT = 10

function totpFor(secret: string, email: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: 'Chapters',
    label: email,
    secret: OTPAuth.Secret.fromBase32(secret),
  })
}

export function generateTotpSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32
}

export function provisioningUri(secret: string, email: string): string {
  return totpFor(secret, email).toString()
}

export function verifyTotp(secret: string, email: string, code: string): boolean {
  return totpFor(secret, email).validate({ token: code, window: 1 }) !== null
}

/** Issues fresh backup codes (returned raw exactly once, stored hashed). */
export async function issueBackupCodes(userId: string): Promise<string[]> {
  await db.delete(mfaBackupCodes).where(eq(mfaBackupCodes.userId, userId))
  const codes = Array.from({ length: BACKUP_CODE_COUNT }, () =>
    randomBytes(4).toString('hex'),
  )
  await db
    .insert(mfaBackupCodes)
    .values(codes.map((code) => ({ userId, codeHash: hashToken(code) })))
  return codes
}

/** Consumes a backup code (single-use). True if it was valid and unused. */
export async function consumeBackupCode(userId: string, code: string): Promise<boolean> {
  const updated = await db
    .update(mfaBackupCodes)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(mfaBackupCodes.userId, userId),
        eq(mfaBackupCodes.codeHash, hashToken(code)),
        isNull(mfaBackupCodes.usedAt),
      ),
    )
    .returning({ id: mfaBackupCodes.id })
  return updated.length > 0
}

/** Validates a TOTP code or, failing that, a single-use backup code. */
export async function verifyMfaCode(
  user: { id: string; email: string; totpSecret: string | null },
  code: string,
): Promise<boolean> {
  if (!user.totpSecret) return false
  if (verifyTotp(user.totpSecret, user.email, code)) return true
  return consumeBackupCode(user.id, code)
}

export async function instanceRequiresMfa(): Promise<boolean> {
  const state = (await db.select().from(instanceState).limit(1))[0]
  return Boolean(state?.requireMfa)
}

export async function setInstanceMfaRequirement(required: boolean): Promise<void> {
  await db.update(instanceState).set({ requireMfa: required })
}

export type MfaUser = typeof users.$inferSelect
