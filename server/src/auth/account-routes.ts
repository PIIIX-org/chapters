import type { FastifyInstance } from 'fastify'
import { and, eq, ne } from 'drizzle-orm'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'
import { sendMail } from '../email/mailer.js'
import { hashPassword, verifyPassword } from './passwords.js'
import { destroyUserSessions } from './sessions.js'
import { generateCode } from './tokens.js'
import { createEmailToken } from './email-tokens.js'
import { logSecurityEvent } from './security-events.js'

// Same floor as signup and reset-password — one minimum, not three.
const PASSWORD_MIN_LENGTH = 8

/** Self-service account settings for the logged-in user. */
export function accountRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth)

  app.post<{ Body: { currentPassword: string; newPassword: string } }>(
    '/me/password',
    {
      schema: {
        body: {
          type: 'object',
          required: ['currentPassword', 'newPassword'],
          properties: {
            currentPassword: { type: 'string', maxLength: 256 },
            newPassword: { type: 'string', minLength: PASSWORD_MIN_LENGTH, maxLength: 256 },
          },
        },
      },
    },
    async (req, reply) => {
      const user = req.user!
      if (!(await verifyPassword(user.passwordHash, req.body.currentPassword))) {
        await logSecurityEvent({
          type: 'password_change_failed',
          subjectUserId: user.id,
          ip: req.ip,
        })
        return reply.code(400).send({ error: 'current password is incorrect' })
      }
      await db
        .update(users)
        .set({ passwordHash: await hashPassword(req.body.newPassword) })
        .where(eq(users.id, user.id))
      // Every other device is signed out; the one doing the change is not.
      await destroyUserSessions(user.id, req.sessionToken ?? undefined)
      await logSecurityEvent({ type: 'password_changed', subjectUserId: user.id, ip: req.ip })
      return { status: 'password_changed' }
    },
  )

  app.post<{ Body: { email: string; password: string } }>(
    '/me/email',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string', maxLength: 256 },
          },
        },
      },
    },
    async (req, reply) => {
      const user = req.user!
      if (!(await verifyPassword(user.passwordHash, req.body.password))) {
        return reply.code(400).send({ error: 'password is incorrect' })
      }
      // Login lowercases before lookup, so storing anything else would create
      // an address nobody can sign in with.
      const email = req.body.email.toLowerCase()
      const taken = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, email), ne(users.id, user.id)))
      if (taken.length > 0) {
        return reply.code(409).send({ error: 'that address is already in use' })
      }
      // Login requires emailVerifiedAt, so this locks the account out until
      // the new address is verified — the UI says so before calling.
      await db.update(users).set({ email, emailVerifiedAt: null }).where(eq(users.id, user.id))
      const code = generateCode()
      await createEmailToken(user.id, 'verify_email', code)
      await sendMail({
        to: email,
        subject: 'Chapters: verify your email',
        text: `Your verification code is ${code}`,
      })
      await logSecurityEvent({ type: 'email_changed', subjectUserId: user.id, ip: req.ip })
      return { status: 'verification_sent' }
    },
  )

  app.get('/me/preferences', async (req) => ({
    emailNotifications: req.user!.emailNotifications,
  }))

  app.put<{ Body: { emailNotifications: boolean } }>(
    '/me/preferences',
    {
      schema: {
        body: {
          type: 'object',
          required: ['emailNotifications'],
          properties: { emailNotifications: { type: 'boolean' } },
        },
      },
    },
    async (req) => {
      const [saved] = await db
        .update(users)
        .set({ emailNotifications: req.body.emailNotifications })
        .where(eq(users.id, req.user!.id))
        .returning({ emailNotifications: users.emailNotifications })
      return saved!
    },
  )
}
