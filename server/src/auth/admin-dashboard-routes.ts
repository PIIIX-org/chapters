import type { FastifyInstance } from 'fastify'
import { and, count, desc, eq, isNull, sql, sum } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  mcpConnections,
  noteRevisions,
  notes,
  securityEvents,
  teamMemberships,
  teams,
  users,
  vaults,
  vaultShares,
} from '../db/schema.js'
import { logSecurityEvent } from './security-events.js'
import { emitPermissionChange } from '../sync/permission-events.js'
import { setInstanceMfaRequirement } from './mfa.js'

/**
 * Admin oversight dashboard (spec): metadata only, never note content —
 * no endpoint here returns a note's text, frontmatter values, or
 * revision bodies. Force-revoke is a structural/access action.
 */
export function adminDashboardRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAdmin)

  app.get('/stats', async () => {
    const usersByStatus = await db
      .select({ status: users.status, count: count() })
      .from(users)
      .groupBy(users.status)
    const [vaultCount] = await db.select({ count: count() }).from(vaults)
    const [teamCount] = await db.select({ count: count() }).from(teams)
    const [noteCount] = await db
      .select({ count: count() })
      .from(notes)
      .where(isNull(notes.deletedAt))
    // ponytail: storage = text length of live notes, not real size-on-disk
    const [storage] = await db
      .select({ bytes: sum(sql<number>`length(${notes.body}) + length(${notes.frontmatter}::text)`) })
      .from(notes)
      .where(isNull(notes.deletedAt))
    const [activeMcp] = await db
      .select({ count: count() })
      .from(mcpConnections)
      .where(isNull(mcpConnections.revokedAt))
    return {
      usersByStatus,
      vaults: vaultCount!.count,
      teams: teamCount!.count,
      notes: noteCount!.count,
      storageBytes: Number(storage!.bytes ?? 0),
      activeMcpConnections: activeMcp!.count,
    }
  })

  app.get('/vaults', async () => {
    const rows = await db
      .select({
        id: vaults.id,
        name: vaults.name,
        ownerEmail: users.email,
        mergeable: vaults.mergeable,
        noteCount: count(notes.id),
        lastActivity: sql<string | null>`max(${notes.updatedAt})`,
      })
      .from(vaults)
      .innerJoin(users, eq(users.id, vaults.ownerId))
      .leftJoin(notes, and(eq(notes.vaultId, vaults.id), isNull(notes.deletedAt)))
      .groupBy(vaults.id, users.email)
    const shares = await db
      .select({ vaultId: vaultShares.vaultId, count: count() })
      .from(vaultShares)
      .groupBy(vaultShares.vaultId)
    const shareCounts = new Map(shares.map((s) => [s.vaultId, s.count]))
    return rows.map((r) => ({ ...r, shareCount: shareCounts.get(r.id) ?? 0 }))
  })

  app.get('/teams', async () => {
    return db
      .select({ id: teams.id, name: teams.name, memberCount: count(teamMemberships.userId) })
      .from(teams)
      .leftJoin(teamMemberships, eq(teamMemberships.teamId, teams.id))
      .groupBy(teams.id)
  })

  app.get<{ Querystring: { limit?: number; offset?: number } }>(
    '/security-events',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            offset: { type: 'integer', minimum: 0, default: 0 },
          },
        },
      },
    },
    async (req) => {
      return db
        .select()
        .from(securityEvents)
        .orderBy(desc(securityEvents.createdAt))
        .limit(req.query.limit ?? 50)
        .offset(req.query.offset ?? 0)
    },
  )

  app.get<{ Querystring: { limit?: number; offset?: number } }>(
    '/audit-trail',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            offset: { type: 'integer', minimum: 0, default: 0 },
          },
        },
      },
    },
    async (req) => {
      // Who/what changed which note, when — never the content itself.
      return db
        .select({
          id: noteRevisions.id,
          notePath: notes.path,
          vaultId: notes.vaultId,
          actorType: noteRevisions.actorType,
          actorId: noteRevisions.actorId,
          action: noteRevisions.action,
          createdAt: noteRevisions.createdAt,
        })
        .from(noteRevisions)
        .innerJoin(notes, eq(notes.id, noteRevisions.noteId))
        .orderBy(desc(noteRevisions.createdAt))
        .limit(req.query.limit ?? 50)
        .offset(req.query.offset ?? 0)
    },
  )

  app.get('/shares', async () => {
    return db.select().from(vaultShares)
  })

  // Incident-response lever: structural revocation, instance-wide.
  app.delete<{ Params: { shareId: string } }>('/shares/:shareId', async (req, reply) => {
    const [share] = await db
      .delete(vaultShares)
      .where(eq(vaultShares.id, req.params.shareId))
      .returning()
    if (!share) return reply.code(404).send({ error: 'share not found' })
    await logSecurityEvent({
      type: 'admin_force_revoked_share',
      actorUserId: req.user!.id,
      detail: { shareId: share.id, vaultId: share.vaultId },
    })
    emitPermissionChange({ vaultIds: [share.vaultId] })
    return { status: 'revoked' }
  })

  app.post<{ Params: { id: string } }>('/mcp-connections/:id/revoke', async (req, reply) => {
    const [connection] = await db
      .update(mcpConnections)
      .set({ revokedAt: new Date() })
      .where(and(eq(mcpConnections.id, req.params.id), isNull(mcpConnections.revokedAt)))
      .returning()
    if (!connection) return reply.code(404).send({ error: 'connection not found' })
    await logSecurityEvent({
      type: 'admin_force_revoked_mcp_connection',
      actorUserId: req.user!.id,
      mcpConnectionId: connection.id,
      subjectUserId: connection.userId,
    })
    return { status: 'revoked' }
  })

  app.put<{ Body: { required: boolean } }>(
    '/mfa-requirement',
    {
      schema: {
        body: {
          type: 'object',
          required: ['required'],
          properties: { required: { type: 'boolean' } },
        },
      },
    },
    async (req) => {
      await setInstanceMfaRequirement(req.body.required)
      await logSecurityEvent({
        type: 'mfa_requirement_changed',
        actorUserId: req.user!.id,
        detail: { required: req.body.required },
      })
      return { required: req.body.required }
    },
  )
}
