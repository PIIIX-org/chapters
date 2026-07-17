import type { FastifyInstance } from 'fastify'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { resolveMcpToken } from '../vaults/mcp-connection-routes.js'
import { logSecurityEvent } from '../auth/security-events.js'
import { buildMcpServer } from './server.js'
import { checkRateLimit } from './rate-limit.js'

/**
 * MCP endpoint: stateless Streamable HTTP — a fresh server+transport per
 * request, authenticated per request against live permissions (spec 6:
 * access is recomputed on every call, no cross-connection caching — the
 * per-request lifecycle makes shared caching impossible by construction).
 */
export function mcpRoutes(app: FastifyInstance) {
  app.post('/mcp', async (req, reply) => {
    const header = req.headers.authorization
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null
    const auth = token ? await resolveMcpToken(token) : null
    if (!auth) {
      await logSecurityEvent({ type: 'mcp_auth_failed', ip: req.ip })
      return reply.code(401).send({ error: 'invalid or revoked MCP token' })
    }
    if (!checkRateLimit(auth.connection.id)) {
      return reply.code(429).send({ error: 'rate limit exceeded for this connection' })
    }

    const server = buildMcpServer(auth)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    reply.hijack()
    await server.connect(transport)
    await transport.handleRequest(req.raw, reply.raw, req.body)
    reply.raw.on('close', () => {
      void transport.close()
      void server.close()
    })
  })
}
