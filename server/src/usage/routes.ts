import type { FastifyInstance } from 'fastify'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { logSecurityEvent } from '../auth/security-events.js'
import { isInstanceAdmin } from '../graph/perspective-access.js'
import type { McpAuth } from '../vaults/mcp-connection-routes.js'
import { flushUsage, loadUsageSetting, recordClientEvent, setUsageEnabled, usageEnabled } from './recorder.js'
import { usageReport } from './report.js'

/**
 * The usage report over REST (#678), under `/api/usage`, for a signed-in
 * user: `GET /settings` (whether it is on), `PUT /settings` (instance owner
 * only), `GET /report` (the caller's account; `?scope=instance` for an
 * instance admin, aggregates only). No UI yet.
 */
export function usageRoutes(app: FastifyInstance) {
  app.addHook('onReady', loadUsageSetting)
  // Shutdown (and a test's app.close) writes what is still queued.
  app.addHook('onClose', async () => flushUsage())
  app.addHook('preHandler', app.requireAuth)

  app.get('/settings', async () => ({ enabled: usageEnabled() }))

  app.put<{ Body: { enabled: boolean } }>(
    '/settings',
    {
      schema: {
        body: { type: 'object', required: ['enabled'], additionalProperties: false, properties: { enabled: { type: 'boolean' } } },
      },
    },
    async (req, reply) => {
      if (req.user!.role !== 'owner') return reply.code(403).send({ error: 'instance owner required' })
      await setUsageEnabled(req.body.enabled)
      await logSecurityEvent({ type: 'usage_report_changed', actorUserId: req.user!.id, ip: req.ip, detail: { enabled: req.body.enabled } })
      return { enabled: req.body.enabled }
    },
  )

  app.get<{ Querystring: { scope?: 'account' | 'instance' } }>(
    '/report',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { scope: { enum: ['account', 'instance'] } } } } },
    async (req, reply) => {
      if (req.query.scope === 'instance') {
        if (!isInstanceAdmin(req.user!.role)) return reply.code(403).send({ error: 'admin required' })
        return usageReport({ kind: 'instance' })
      }
      return usageReport({ kind: 'account', accountId: req.user!.id })
    },
  )
}

/**
 * The hook for a client to report what the server cannot see (#678): a
 * JSON-RPC notification `notifications/elara/client_event` on the MCP
 * endpoint, `{event: "local_fallback", session_id?}` when the agent turned
 * to its local tools (grep, file reads) after Elara's. A notification, so it
 * costs no tools/list tokens and answers nothing; an unknown event is
 * ignored. Recorded only while the report is on (`recordClientEvent`).
 */
const ClientEventNotification = z.object({
  method: z.literal('notifications/elara/client_event'),
  params: z.looseObject({ event: z.unknown().optional(), session_id: z.unknown().optional() }).optional(),
})

export function acceptClientEvents(server: McpServer, auth: McpAuth): void {
  server.server.setNotificationHandler(ClientEventNotification, (notification) => {
    const { event, session_id: sessionId } = notification.params ?? {}
    if (event !== 'local_fallback') return
    recordClientEvent(auth, event, typeof sessionId === 'string' && sessionId.length <= 200 ? sessionId : null)
  })
}
