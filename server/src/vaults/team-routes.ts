import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { teamMemberships, teams, users, vaults, vaultShares } from '../db/schema.js'
import { notify } from '../notifications/notify.js'
import { emitPermissionChange } from '../sync/permission-events.js'

async function isTeamOwner(userId: string, teamId: string): Promise<boolean> {
  const row = (
    await db
      .select()
      .from(teamMemberships)
      .where(
        and(
          eq(teamMemberships.teamId, teamId),
          eq(teamMemberships.userId, userId),
          eq(teamMemberships.role, 'owner'),
        ),
      )
  )[0]
  return Boolean(row)
}

/**
 * Hardening (sub-project 1): when a team's membership changes, notify the
 * owners of every vault currently shared with that team.
 */
async function notifyVaultOwnersOfMembershipChange(
  teamId: string,
  message: string,
): Promise<void> {
  const affected = await db
    .select({ ownerId: vaults.ownerId, vaultName: vaults.name })
    .from(vaultShares)
    .innerJoin(vaults, eq(vaults.id, vaultShares.vaultId))
    .where(and(eq(vaultShares.granteeType, 'team'), eq(vaultShares.granteeId, teamId)))
  for (const { ownerId, vaultName } of affected) {
    await notify({
      recipientId: ownerId,
      type: 'team_membership_changed',
      entityType: 'team',
      entityId: teamId,
      message: `${message} (team has access to your vault "${vaultName}").`,
    })
  }
}

export function teamRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth)

  app.post<{ Body: { name: string } }>(
    '/teams',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string', minLength: 1, maxLength: 200 } },
        },
      },
    },
    async (req) => {
      const [team] = await db.insert(teams).values({ name: req.body.name }).returning()
      await db
        .insert(teamMemberships)
        .values({ teamId: team!.id, userId: req.user!.id, role: 'owner' })
      return team
    },
  )

  app.get('/teams', async (req) => {
    return db
      .select({ id: teams.id, name: teams.name, role: teamMemberships.role })
      .from(teamMemberships)
      .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
      .where(eq(teamMemberships.userId, req.user!.id))
  })

  app.get<{ Params: { id: string } }>('/teams/:id/members', async (req, reply) => {
    const membership = (
      await db
        .select()
        .from(teamMemberships)
        .where(
          and(eq(teamMemberships.teamId, req.params.id), eq(teamMemberships.userId, req.user!.id)),
        )
    )[0]
    if (!membership) return reply.code(404).send({ error: 'not found' })
    return db
      .select({ userId: users.id, email: users.email, role: teamMemberships.role })
      .from(teamMemberships)
      .innerJoin(users, eq(users.id, teamMemberships.userId))
      .where(eq(teamMemberships.teamId, req.params.id))
  })

  app.post<{ Params: { id: string }; Body: { userId: string } }>(
    '/teams/:id/members',
    {
      schema: {
        body: {
          type: 'object',
          required: ['userId'],
          properties: { userId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (req, reply) => {
      if (!(await isTeamOwner(req.user!.id, req.params.id))) {
        return reply.code(403).send({ error: 'team owner required' })
      }
      const member = (await db.select().from(users).where(eq(users.id, req.body.userId)))[0]
      if (!member || member.status !== 'active') {
        return reply.code(400).send({ error: 'user must be active' })
      }
      await db
        .insert(teamMemberships)
        .values({ teamId: req.params.id, userId: member.id })
        .onConflictDoNothing()
      const team = (await db.select().from(teams).where(eq(teams.id, req.params.id)))[0]!
      await notify({
        recipientId: member.id,
        type: 'team_membership_changed',
        entityType: 'team',
        entityId: team.id,
        message: `You were added to team "${team.name}".`,
      })
      await notifyVaultOwnersOfMembershipChange(
        team.id,
        `${member.email} was added to team "${team.name}"`,
      )
      emitPermissionChange({ userIds: [member.id] })
      return { status: 'added' }
    },
  )

  app.delete<{ Params: { id: string; userId: string } }>(
    '/teams/:id/members/:userId',
    async (req, reply) => {
      if (!(await isTeamOwner(req.user!.id, req.params.id))) {
        return reply.code(403).send({ error: 'team owner required' })
      }
      const [removed] = await db
        .delete(teamMemberships)
        .where(
          and(
            eq(teamMemberships.teamId, req.params.id),
            eq(teamMemberships.userId, req.params.userId),
            eq(teamMemberships.role, 'member'),
          ),
        )
        .returning()
      if (!removed) return reply.code(404).send({ error: 'membership not found' })
      const team = (await db.select().from(teams).where(eq(teams.id, req.params.id)))[0]!
      const member = (await db.select().from(users).where(eq(users.id, req.params.userId)))[0]
      await notify({
        recipientId: req.params.userId,
        type: 'team_membership_changed',
        entityType: 'team',
        entityId: team.id,
        message: `You were removed from team "${team.name}".`,
      })
      await notifyVaultOwnersOfMembershipChange(
        team.id,
        `${member?.email ?? 'a user'} was removed from team "${team.name}"`,
      )
      emitPermissionChange({ userIds: [req.params.userId] })
      return { status: 'removed' }
    },
  )

  app.delete<{ Params: { id: string } }>('/teams/:id', async (req, reply) => {
    if (!(await isTeamOwner(req.user!.id, req.params.id))) {
      return reply.code(403).send({ error: 'team owner required' })
    }
    // Cascade per spec hardening: shares to this team must not dangle.
    const removed = await db
      .delete(vaultShares)
      .where(and(eq(vaultShares.granteeType, 'team'), eq(vaultShares.granteeId, req.params.id)))
      .returning({ vaultId: vaultShares.vaultId })
    await db.delete(teams).where(eq(teams.id, req.params.id))
    if (removed.length > 0) emitPermissionChange({ vaultIds: removed.map((r) => r.vaultId) })
    return { status: 'deleted' }
  })
}
