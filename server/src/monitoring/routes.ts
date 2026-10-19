import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../config.js'
import { metricsSnapshot } from './metrics.js'

/** Constant-time match of an `Authorization: Bearer` value against ELARA_MONITORING_TOKEN (unset = never). */
export function isMonitoringToken(header: string | undefined): boolean {
  const expected = config.monitoringToken
  const m = /^Bearer (\S+)$/.exec(header ?? '')
  if (!expected || !m) return false
  // Hashed first: timingSafeEqual needs equal lengths, and the length must not leak either.
  return timingSafeEqual(createHash('sha256').update(m[1]!).digest(), createHash('sha256').update(expected).digest())
}

/**
 * GET /api/admin/monitoring (#705): request and job metrics and the last
 * error reports (metrics.ts), for the uptime monitor. Either the monitoring
 * token (`Authorization: Bearer $ELARA_MONITORING_TOKEN`; no session, no
 * database read) or an admin session. `/health` stays as it was.
 */
export function monitoringRoutes(app: FastifyInstance) {
  app.get('/monitoring', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.headers.authorization !== undefined) {
      if (!isMonitoringToken(req.headers.authorization)) return reply.code(401).send({ error: 'invalid monitoring token' })
    } else {
      await app.requireAdmin(req, reply)
      if (reply.sent) return reply
    }
    void reply.header('cache-control', 'no-store')
    return metricsSnapshot()
  })
}
