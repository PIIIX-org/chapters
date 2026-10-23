import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { resolveMcpToken } from '../vaults/mcp-connection-routes.js'
import { logSecurityEvent } from '../auth/security-events.js'
import { buildMcpServer } from './server.js'
import { checkRateLimit } from './rate-limit.js'
import { rateLimitedError } from './errors.js'
import { noteTransportLimit } from '../notes/size-cap.js'

/**
 * MCP endpoint: stateless Streamable HTTP — a fresh server+transport per
 * request, authenticated per request against live permissions (spec 6:
 * access is recomputed on every call, no cross-connection caching — the
 * per-request lifecycle makes shared caching impossible by construction).
 * Registers both canonical `/elara/mcp` and permanent backward-compatible `/mcp`.
 */
export function mcpRoutes(app: FastifyInstance) {
  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null
    const auth = token ? await resolveMcpToken(token) : null
    if (!auth) {
      await logSecurityEvent({ type: 'mcp_auth_failed', ip: req.ip })
      return reply.code(401).send({ error: 'invalid, revoked or expired MCP token' })
    }
    const limit = checkRateLimit(auth.connection.id)
    if (!limit.ok) {
      // A JSON-RPC error answering the request (#440): its `id` when the body
      // is one request with an id, else null (a batch, a notification); the
      // error envelope (#439) as `data`; Retry-After in whole seconds.
      const body: unknown = req.body
      const id =
        body && typeof body === 'object' && !Array.isArray(body) && 'id' in body && (typeof body.id === 'string' || typeof body.id === 'number')
          ? body.id
          : null
      const error = rateLimitedError(limit.retryAfterMs)
      return reply
        .code(429)
        .header('retry-after', String(Math.ceil(limit.retryAfterMs / 1000)))
        .send({ jsonrpc: '2.0', id, error: { code: -32000, message: error.message, data: error } })
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
  }

  // Room for a note body at the cap (#491); create_note/edit_note check the body itself.
  const options = { bodyLimit: noteTransportLimit() }
  app.post('/mcp', options, handler)
  app.post('/elara/mcp', options, handler)

  // Stateless: no session to end and no GET stream to open, so no
  // list_changed or other server-sent message (initialize advertises
  // `listChanged: false`, #436). Streamable HTTP expects 405 for these; the
  // body is the JSON-RPC error the SDK's own transport sends for them.
  const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply
      .code(405)
      .header('allow', 'POST')
      .send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null })
  for (const url of ['/mcp', '/elara/mcp']) app.route({ method: ['GET', 'DELETE'], url, handler: notAllowed })
}
