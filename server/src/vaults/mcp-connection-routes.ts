import type { FastifyInstance } from 'fastify'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { mcpConnections, users } from '../db/schema.js'
import { generateToken, hashToken } from '../auth/tokens.js'
import { logSecurityEvent } from '../auth/security-events.js'
import { ACCESS_RANK, listMcpTools, type ToolCapability } from '../mcp/server.js'
import { resolveAccess, type Access } from './permissions.js'
import { resolveRepositoryAccess, type RepoAccess } from '../repositories/permissions.js'

/**
 * The most a pinned token may do, by its minter's permission on the pin
 * (#649): only the owner grants admin, a read-only vault share caps it at
 * read. Repository shares have no read-only tier.
 */
const PIN_ACCESS_CEILING: Record<Access | RepoAccess, ToolCapability> = {
  owner: 'admin',
  edit: 'write',
  read: 'read',
  viewer: 'write',
}

export function mcpConnectionRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth)

  app.post<{
    Body: {
      name: string
      scope: 'account' | 'vault' | 'repository'
      vaultId?: string
      repositoryId?: string
      access?: ToolCapability
      allowedTools?: string[]
      expiresAt?: string
    }
  }>(
    '/mcp-connections',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'scope'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            scope: { enum: ['account', 'vault', 'repository'] },
            vaultId: { type: 'string', format: 'uuid' },
            repositoryId: { type: 'string', format: 'uuid' },
            access: { enum: ['read', 'write', 'admin'] },
            allowedTools: {
              type: 'array',
              minItems: 1,
              maxItems: 200,
              uniqueItems: true,
              items: { type: 'string', minLength: 1, maxLength: 100 },
            },
            expiresAt: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (req, reply) => {
      const { name, scope, vaultId, repositoryId, allowedTools } = req.body
      // Capabilities are set here and never raised later (#548). Without an
      // explicit level an account token keeps every tool, as before; a pinned
      // token gets `write`: no share, update, delete or purge on its pin (#549).
      let access: ToolCapability = req.body.access ?? (scope === 'account' ? 'admin' : 'write')
      let pinAccess: Access | RepoAccess | null = null
      if (scope === 'vault') {
        if (!vaultId) return reply.code(400).send({ error: 'vaultId required for vault scope' })
        pinAccess = await resolveAccess(req.user!.id, vaultId)
        if (!pinAccess) return reply.code(404).send({ error: 'vault not found' })
      }
      if (scope === 'repository') {
        if (!repositoryId) return reply.code(400).send({ error: 'repositoryId required for repository scope' })
        pinAccess = await resolveRepositoryAccess(req.user!.id, repositoryId)
        if (!pinAccess) return reply.code(404).send({ error: 'repository not found' })
      }
      // A pinned token never does more than its minter may on the pin (#649).
      // A level asked for above that is refused; the default is lowered to it.
      if (pinAccess !== null) {
        const ceiling = PIN_ACCESS_CEILING[pinAccess]
        if (ACCESS_RANK[access] > ACCESS_RANK[ceiling]) {
          if (req.body.access === undefined) {
            access = ceiling
          } else if (access === 'admin') {
            return reply.code(403).send({ error: `admin access on a ${scope}-pinned connection requires owning the ${scope}` })
          } else {
            return reply.code(403).send({
              error: `${access} access on a ${scope}-pinned connection requires edit permission on the ${scope}; you have ${pinAccess} permission, so mint a ${ceiling} token`,
            })
          }
        }
      }
      if (allowedTools) {
        const known = new Set(listMcpTools().map((t) => t.name))
        const unknown = allowedTools.filter((t) => !known.has(t))
        if (unknown.length) return reply.code(400).send({ error: `unknown MCP tools: ${unknown.join(', ')}` })
      }
      const expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null
      if (expiresAt && expiresAt <= new Date()) {
        return reply.code(400).send({ error: 'expiresAt must be in the future' })
      }
      const token = generateToken()
      const [connection] = await db
        .insert(mcpConnections)
        .values({
          userId: req.user!.id,
          name,
          scope,
          vaultId: scope === 'vault' ? vaultId : null,
          repositoryId: scope === 'repository' ? repositoryId : null,
          tokenHash: hashToken(token),
          access,
          allowedTools: allowedTools ?? null,
          expiresAt,
        })
        .returning()
      await logSecurityEvent({
        type: 'mcp_connection_created',
        actorUserId: req.user!.id,
        mcpConnectionId: connection!.id,
        detail: { scope, vaultId, repositoryId, access, allowedTools: allowedTools ?? null, expiresAt },
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

  // The tools a connection can be limited to, with the access level each needs.
  app.get('/mcp-connections/tools', async () => listMcpTools())

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
    repositoryId: c.repositoryId,
    access: c.access,
    allowedTools: c.allowedTools,
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
