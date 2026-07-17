import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'
import { logSecurityEvent } from './security-events.js'
import {
  generateTotpSecret,
  instanceRequiresMfa,
  issueBackupCodes,
  provisioningUri,
  verifyMfaCode,
  verifyTotp,
} from './mfa.js'

const codeBody = {
  type: 'object',
  required: ['code'],
  properties: { code: { type: 'string', minLength: 6, maxLength: 16 } },
} as const

export function mfaRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth)

  /** Step 1: provision a pending secret (not active until verified). */
  app.post('/mfa/setup', async (req) => {
    const secret = generateTotpSecret()
    await db
      .update(users)
      .set({ totpSecret: secret, mfaEnabledAt: null })
      .where(eq(users.id, req.user!.id))
    return { secret, uri: provisioningUri(secret, req.user!.email) }
  })

  /** Step 2: prove the authenticator works; backup codes shown once. */
  app.post<{ Body: { code: string } }>(
    '/mfa/enable',
    { schema: { body: codeBody } },
    async (req, reply) => {
      const user = (await db.select().from(users).where(eq(users.id, req.user!.id)))[0]!
      if (!user.totpSecret || user.mfaEnabledAt) {
        return reply.code(400).send({ error: 'no pending MFA setup' })
      }
      if (!verifyTotp(user.totpSecret, user.email, req.body.code)) {
        return reply.code(400).send({ error: 'invalid code' })
      }
      await db.update(users).set({ mfaEnabledAt: new Date() }).where(eq(users.id, user.id))
      const backupCodes = await issueBackupCodes(user.id)
      await logSecurityEvent({ type: 'mfa_enabled', subjectUserId: user.id })
      return { status: 'enabled', backupCodes }
    },
  )

  app.post<{ Body: { code: string } }>(
    '/mfa/disable',
    { schema: { body: codeBody } },
    async (req, reply) => {
      const user = (await db.select().from(users).where(eq(users.id, req.user!.id)))[0]!
      if (!user.mfaEnabledAt) return reply.code(400).send({ error: 'MFA is not enabled' })
      if (await instanceRequiresMfa()) {
        return reply.code(403).send({ error: 'MFA is required on this instance' })
      }
      if (!(await verifyMfaCode(user, req.body.code))) {
        return reply.code(400).send({ error: 'invalid code' })
      }
      await db
        .update(users)
        .set({ totpSecret: null, mfaEnabledAt: null })
        .where(eq(users.id, user.id))
      await logSecurityEvent({ type: 'mfa_disabled', subjectUserId: user.id })
      return { status: 'disabled' }
    },
  )
}
