import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { instanceState, users } from '../db/schema.js'
import { sendMail } from '../email/mailer.js'
import { hashPassword, verifyPassword } from './passwords.js'
import { createSession, destroySession, destroyUserSessions } from './sessions.js'
import { generateCode, generateToken, hashToken } from './tokens.js'
import { createEmailToken, consumeEmailToken } from './email-tokens.js'
import { clearFailures, isLocked, recordFailure } from './lockout.js'
import { logSecurityEvent } from './security-events.js'
import { isSetupComplete } from './bootstrap.js'
import { verifyMfaCode } from './mfa.js'
import { SESSION_COOKIE } from './plugin.js'

const credentialsSchema = {
  type: 'object',
  required: ['email', 'password'],
  properties: {
    email: { type: 'string', format: 'email' },
    password: { type: 'string', minLength: 8, maxLength: 256 },
  },
} as const

const strictRateLimit = {
  // Per-IP throttle on the abuse-sensitive routes; effectively off under test
  // (tests exercise the per-account lockout instead).
  rateLimit: {
    max: process.env.NODE_ENV === 'test' ? 100_000 : 10,
    timeWindow: '1 minute',
  },
} as const

function sessionCookieOptions(isProd: boolean) {
  return {
    path: '/',
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax' as const,
    maxAge: 30 * 24 * 60 * 60,
  }
}

export function authRoutes(app: FastifyInstance, opts: { isProd: boolean }) {
  const cookieOpts = sessionCookieOptions(opts.isProd)

  app.post<{ Body: { token: string; email: string; password: string } }>(
    '/setup',
    {
      config: strictRateLimit,
      schema: {
        body: {
          ...credentialsSchema,
          required: ['token', 'email', 'password'],
          properties: {
            ...credentialsSchema.properties,
            token: { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const state = (await db.select().from(instanceState).limit(1))[0]
      if (!state || state.setupCompletedAt || !state.setupTokenHash) {
        return reply.code(404).send({ error: 'setup is not available' })
      }
      if (hashToken(req.body.token) !== state.setupTokenHash) {
        await logSecurityEvent({ type: 'setup_token_rejected', ip: req.ip })
        return reply.code(403).send({ error: 'invalid setup token' })
      }
      const [admin] = await db
        .insert(users)
        .values({
          email: req.body.email.toLowerCase(),
          passwordHash: await hashPassword(req.body.password),
          status: 'active',
          role: 'admin',
          emailVerifiedAt: new Date(),
        })
        .returning()
      await db
        .update(instanceState)
        .set({ setupCompletedAt: new Date(), setupTokenHash: null })
        .where(eq(instanceState.id, 'singleton'))
      await logSecurityEvent({ type: 'setup_completed', subjectUserId: admin!.id, ip: req.ip })
      const token = await createSession(admin!.id)
      return reply.setCookie(SESSION_COOKIE, token, cookieOpts).send({ id: admin!.id })
    },
  )

  app.post<{ Body: { email: string; password: string } }>(
    '/signup',
    { config: strictRateLimit, schema: { body: credentialsSchema } },
    async (req, reply) => {
      if (!(await isSetupComplete())) {
        return reply.code(403).send({ error: 'instance setup is not complete' })
      }
      const email = req.body.email.toLowerCase()
      const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email))
      if (existing.length > 0) {
        // Same response as success — no account enumeration.
        return reply.send({ status: 'pending_approval' })
      }
      const [user] = await db
        .insert(users)
        .values({ email, passwordHash: await hashPassword(req.body.password) })
        .returning()
      const code = generateCode()
      await createEmailToken(user!.id, 'verify_email', code)
      await sendMail({
        to: email,
        subject: 'Chapters: verify your email',
        text: `Your verification code is ${code}`,
      })
      return reply.send({ status: 'pending_approval' })
    },
  )

  app.post<{ Body: { email: string; code: string } }>(
    '/verify-email',
    {
      config: strictRateLimit,
      schema: {
        body: {
          type: 'object',
          required: ['email', 'code'],
          properties: {
            email: { type: 'string', format: 'email' },
            code: { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const email = req.body.email.toLowerCase()
      const user = (await db.select().from(users).where(eq(users.email, email)))[0]
      if (!user) return reply.code(400).send({ error: 'invalid code' })
      const consumed = await consumeEmailToken('verify_email', req.body.code, user.id)
      if (!consumed) return reply.code(400).send({ error: 'invalid code' })
      await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, user.id))
      return reply.send({ status: 'verified' })
    },
  )

  app.post<{ Body: { email: string; password: string; totp?: string } }>(
    '/login',
    {
      config: strictRateLimit,
      schema: {
        body: {
          ...credentialsSchema,
          properties: {
            ...credentialsSchema.properties,
            totp: { type: 'string', minLength: 6, maxLength: 16 },
          },
        },
      },
    },
    async (req, reply) => {
      const email = req.body.email.toLowerCase()
      const accountKey = `acct:${email}`
      const ipKey = `ip:${req.ip}`
      if (isLocked(accountKey) || isLocked(ipKey)) {
        await logSecurityEvent({ type: 'login_locked_out', ip: req.ip, detail: { email } })
        return reply.code(429).send({ error: 'too many failed attempts, try again later' })
      }
      const user = (await db.select().from(users).where(eq(users.email, email)))[0]
      const valid = user && (await verifyPassword(user.passwordHash, req.body.password))
      if (!valid || user.status !== 'active' || !user.emailVerifiedAt) {
        recordFailure(accountKey)
        recordFailure(ipKey)
        await logSecurityEvent({ type: 'login_failed', ip: req.ip, detail: { email } })
        return reply.code(401).send({ error: 'invalid credentials' })
      }
      // MFA spec: every login is challenged when TOTP is enabled — no
      // device-trust exception. Backup codes accepted in the same field.
      if (user.mfaEnabledAt) {
        if (!req.body.totp) {
          return reply.code(401).send({ error: 'totp code required', mfaRequired: true })
        }
        if (!(await verifyMfaCode(user, req.body.totp))) {
          recordFailure(accountKey)
          recordFailure(ipKey)
          await logSecurityEvent({ type: 'login_mfa_failed', ip: req.ip, detail: { email } })
          return reply.code(401).send({ error: 'invalid totp code', mfaRequired: true })
        }
      }
      clearFailures(accountKey)
      const token = await createSession(user.id)
      return reply
        .setCookie(SESSION_COOKIE, token, cookieOpts)
        .send({ id: user.id, email: user.email, role: user.role })
    },
  )

  app.post('/logout', { preHandler: app.requireAuth }, async (req, reply) => {
    if (req.sessionToken) await destroySession(req.sessionToken)
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).send({ status: 'logged_out' })
  })

  app.get('/me', { preHandler: app.requireAuth }, async (req) => {
    const { id, email, status, role, createdAt } = req.user!
    return { id, email, status, role, createdAt }
  })

  app.post<{ Body: { email: string } }>(
    '/request-password-reset',
    {
      config: strictRateLimit,
      schema: {
        body: {
          type: 'object',
          required: ['email'],
          properties: { email: { type: 'string', format: 'email' } },
        },
      },
    },
    async (req, reply) => {
      const email = req.body.email.toLowerCase()
      const user = (await db.select().from(users).where(eq(users.email, email)))[0]
      if (user && user.emailVerifiedAt) {
        const raw = generateToken()
        await createEmailToken(user.id, 'password_reset', raw)
        await sendMail({
          to: email,
          subject: 'Chapters: password reset',
          text: `Your password reset token: ${raw}`,
        })
      }
      // Identical response either way — no enumeration.
      return reply.send({ status: 'ok' })
    },
  )

  app.post<{ Body: { token: string; password: string } }>(
    '/reset-password',
    {
      config: strictRateLimit,
      schema: {
        body: {
          type: 'object',
          required: ['token', 'password'],
          properties: {
            token: { type: 'string' },
            password: { type: 'string', minLength: 8, maxLength: 256 },
          },
        },
      },
    },
    async (req, reply) => {
      const userId = await consumeEmailToken('password_reset', req.body.token)
      if (!userId) return reply.code(400).send({ error: 'invalid or expired token' })
      await db
        .update(users)
        .set({ passwordHash: await hashPassword(req.body.password) })
        .where(eq(users.id, userId))
      await destroyUserSessions(userId)
      await logSecurityEvent({ type: 'password_reset', subjectUserId: userId, ip: req.ip })
      return reply.send({ status: 'password_updated' })
    },
  )
}
