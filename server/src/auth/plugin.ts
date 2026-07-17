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

  const MFA_EXEMPT = ['/api/mfa', '/api/logout', '/api/me']

  app.decorate('requireAuth', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) {
      await reply.code(401).send({ error: 'authentication required' })
      return
    }
    // Admin-mandated MFA: users without TOTP may only reach the setup
    // surface until they enable it (MFA spec enforcement rule).
    if (!req.user.mfaEnabledAt && !MFA_EXEMPT.some((p) => req.url.startsWith(p))) {
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
