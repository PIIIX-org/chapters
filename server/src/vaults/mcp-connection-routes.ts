import type { FastifyInstance } from 'fastify'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { mcpConnections, users } from '../db/schema.js'
import { generateToken, hashToken } from '../auth/tokens.js'
import { logSecurityEvent } from '../auth/security-events.js'
import { resolveAccess } from './permissions.js'

export function mcpConnectionRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth)

  app.post<{ Body: { name: string; scope: 'account' | 'vault'; vaultId?: string } }>(
    '/mcp-connections',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'scope'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            scope: { enum: ['account', 'vault'] },
            vaultId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (req, reply) => {
      const { name, scope, vaultId } = req.body
      if (scope === 'vault') {
        if (!vaultId) return reply.code(400).send({ error: 'vaultId required for vault scope' })
        const access = await resolveAccess(req.user!.id, vaultId)
        if (!access) return reply.code(404).send({ error: 'vault not found' })
      }
      const token = generateToken()
      const [connection] = await db
        .insert(mcpConnections)
        .values({
          userId: req.user!.id,
          name,
          scope,
          vaultId: scope === 'vault' ? vaultId : null,
          tokenHash: hashToken(token),
        })
        .returning()
      await logSecurityEvent({
        type: 'mcp_connection_created',
        actorUserId: req.user!.id,
        mcpConnectionId: connection!.id,
        detail: { scope, vaultId },
      })
      // The raw token is returned exactly once and stored only as a hash.
      return { ...connectionView(connection!), token }
    },
  )

  app.get('/mcp-connections', async (req) => {
    const rows = await db
      .select()
      .from(mcpConnections)
      .where(eq(mcpConnections.userId, req.user!.id))
    return rows.map(connectionView)
  })

  app.post<{ Params: { id: string } }>('/mcp-connections/:id/revoke', async (req, reply) => {
    const [connection] = await db
      .update(mcpConnections)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(mcpConnections.id, req.params.id),
          eq(mcpConnections.userId, req.user!.id),
          isNull(mcpConnections.revokedAt),
        ),
      )
      .returning()
    if (!connection) return reply.code(404).send({ error: 'connection not found' })
    await logSecurityEvent({
      type: 'mcp_connection_revoked',
      actorUserId: req.user!.id,
      mcpConnectionId: connection.id,
    })
    return { status: 'revoked' }
  })
}

function connectionView(c: typeof mcpConnections.$inferSelect) {
  return {
    id: c.id,
    name: c.name,
    scope: c.scope,
    vaultId: c.vaultId,
    createdAt: c.createdAt,
    lastUsedAt: c.lastUsedAt,
    expiresAt: c.expiresAt,
    revokedAt: c.revokedAt,
  }
}

export type McpAuth = {
  connection: typeof mcpConnections.$inferSelect
  user: typeof users.$inferSelect
}

/**
 * Resolves a bearer token to its connection + owning user, or null.
 * Live checks only (spec): revoked/expired connections and non-active
 * owners never resolve, regardless of when the token was issued.
 */
export async function resolveMcpToken(token: string): Promise<McpAuth | null> {
  const rows = await db
    .select({ connection: mcpConnections, user: users })
    .from(mcpConnections)
    .innerJoin(users, eq(users.id, mcpConnections.userId))
    .where(eq(mcpConnections.tokenHash, hashToken(token)))
    .limit(1)
  const row = rows[0]
  if (!row) return null
  const { connection, user } = row
  if (connection.revokedAt) return null
  if (connection.expiresAt && connection.expiresAt < new Date()) return null
  if (user.status !== 'active') return null
  await db
    .update(mcpConnections)
    .set({ lastUsedAt: new Date() })
    .where(eq(mcpConnections.id, connection.id))
  return { connection, user }
}
