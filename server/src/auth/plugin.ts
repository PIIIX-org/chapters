import fp from 'fastify-plugin'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { getSessionUser, type SessionUser } from './sessions.js'
import { logSecurityEvent } from './security-events.js'
import { instanceRequiresMfa } from './mfa.js'

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null
    sessionToken: string | null
  }
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}

export const SESSION_COOKIE = 'sid'

export const authPlugin = fp(async (app) => {
  app.decorateRequest('user', null)
  app.decorateRequest('sessionToken', null)

  app.addHook('onRequest', async (req) => {
    const token = req.cookies[SESSION_COOKIE]
    if (token) {
      req.sessionToken = token
      req.user = await getSessionUser(token)
    }
  })

  // Prefix-matched (the whole /mfa surface) vs exact (one endpoint each).
  // /api/me must NOT be a prefix: it would also exempt /api/me/password,
  // /api/me/email, /api/me/preferences and /api/me/export, so a user under an
  // instance mandate who had not enrolled could still change their address and
  // download every note they own — the exact reach the mandate exists to stop.
  const MFA_EXEMPT_PREFIXES = ['/api/mfa']
  const MFA_EXEMPT_EXACT = ['/api/logout', '/api/me']

  function isMfaExempt(url: string): boolean {
    const path = url.split('?')[0]!
    return (
      MFA_EXEMPT_PREFIXES.some((p) => path.startsWith(p)) || MFA_EXEMPT_EXACT.includes(path)
    )
  }

  app.decorate('requireAuth', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) {
      await reply.code(401).send({ error: 'authentication required' })
      return
    }
    // Admin-mandated MFA: users without TOTP may only reach the setup
    // surface until they enable it (MFA spec enforcement rule).
    if (!req.user.mfaEnabledAt && !isMfaExempt(req.url)) {
      if (await instanceRequiresMfa()) {
        await reply.code(403).send({ error: 'MFA setup required', mfaSetupRequired: true })
      }
    }
  })

  app.decorate('requireAdmin', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) {
      await reply.code(401).send({ error: 'authentication required' })
      return
    }
    if (req.user.role !== 'admin') {
      await logSecurityEvent({
        type: 'permission_denied',
        actorUserId: req.user.id,
        ip: req.ip,
        detail: { route: req.url },
      })
      await reply.code(403).send({ error: 'admin required' })
    }
  })
})
