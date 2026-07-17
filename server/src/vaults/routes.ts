import type { FastifyInstance } from 'fastify'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  teamMemberships,
  teams,
  users,
  vaultGraphPreferences,
  vaults,
  vaultShares,
} from '../db/schema.js'
import { logSecurityEvent } from '../auth/security-events.js'
import { notify } from '../notifications/notify.js'
import { listAccessibleVaults, resolveAccess } from './permissions.js'

async function requireOwner(userId: string, vaultId: string) {
  const access = await resolveAccess(userId, vaultId)
  return access === 'owner'
}

export function vaultRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth)

  app.post<{ Body: { name: string } }>(
    '/vaults',
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
      const [vault] = await db
        .insert(vaults)
        .values({ name: req.body.name, ownerId: req.user!.id })
        .returning()
      return vault
    },
  )

  app.get('/vaults', async (req) => listAccessibleVaults(req.user!.id))

  app.get<{ Params: { id: string } }>('/vaults/:id/access', async (req, reply) => {
    const access = await resolveAccess(req.user!.id, req.params.id)
    if (!access) return reply.code(404).send({ error: 'not found' })
    return { access }
  })

  app.patch<{ Params: { id: string }; Body: { name?: string; mergeable?: boolean } }>(
    '/vaults/:id',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            mergeable: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      if (!(await requireOwner(req.user!.id, req.params.id))) {
        return reply.code(404).send({ error: 'not found' })
      }
      const [vault] = await db
        .update(vaults)
        .set(req.body)
        .where(eq(vaults.id, req.params.id))
        .returning()
      return vault
    },
  )

  app.post<{
    Params: { id: string }
    Body: { granteeType: 'user' | 'team'; granteeId: string; permission: 'read' | 'edit' }
  }>(
    '/vaults/:id/shares',
    {
      schema: {
        body: {
          type: 'object',
          required: ['granteeType', 'granteeId', 'permission'],
          properties: {
            granteeType: { enum: ['user', 'team'] },
            granteeId: { type: 'string', format: 'uuid' },
            permission: { enum: ['read', 'edit'] },
          },
        },
      },
    },
    async (req, reply) => {
      const vaultId = req.params.id
      if (!(await requireOwner(req.user!.id, vaultId))) {
        return reply.code(404).send({ error: 'not found' })
      }
      const { granteeType, granteeId, permission } = req.body
      if (granteeType === 'user') {
        const grantee = (await db.select().from(users).where(eq(users.id, granteeId)))[0]
        if (!grantee || grantee.status !== 'active') {
          return reply.code(400).send({ error: 'grantee must be an active user' })
        }
      } else {
        const team = (await db.select().from(teams).where(eq(teams.id, granteeId)))[0]
        if (!team) return reply.code(400).send({ error: 'team not found' })
      }
      const [share] = await db
        .insert(vaultShares)
        .values({ vaultId, granteeType, granteeId, permission })
        .onConflictDoUpdate({
          target: [vaultShares.vaultId, vaultShares.granteeType, vaultShares.granteeId],
          set: { permission },
        })
        .returning()
      const vault = (await db.select().from(vaults).where(eq(vaults.id, vaultId)))[0]!
      const recipients =
        granteeType === 'user'
          ? [granteeId]
          : (
              await db
                .select({ userId: teamMemberships.userId })
                .from(teamMemberships)
                .where(eq(teamMemberships.teamId, granteeId))
            ).map((m) => m.userId)
      for (const recipientId of recipients) {
        if (recipientId === req.user!.id) continue
        await notify({
          recipientId,
          type: 'vault_shared',
          entityType: 'vault',
          entityId: vaultId,
          message: `Vault "${vault.name}" was shared with you (${permission}).`,
        })
      }
      await logSecurityEvent({
        type: 'vault_share_created',
        actorUserId: req.user!.id,
        detail: { vaultId, granteeType, granteeId, permission },
      })
      return share
    },
  )

  app.get<{ Params: { id: string } }>('/vaults/:id/shares', async (req, reply) => {
    const vaultId = req.params.id
    if (!(await requireOwner(req.user!.id, vaultId))) {
      return reply.code(404).send({ error: 'not found' })
    }
    const shares = await db.select().from(vaultShares).where(eq(vaultShares.vaultId, vaultId))
    // Hardening: expand team shares to the current member list so the
    // owner sees exactly who has access right now, not just the grant.
    const teamIds = shares.filter((s) => s.granteeType === 'team').map((s) => s.granteeId)
    const members = teamIds.length
      ? await db
          .select({
            teamId: teamMemberships.teamId,
            userId: teamMemberships.userId,
            email: users.email,
          })
          .from(teamMemberships)
          .innerJoin(users, eq(users.id, teamMemberships.userId))
          .where(inArray(teamMemberships.teamId, teamIds))
      : []
    return shares.map((s) => ({
      ...s,
      members: s.granteeType === 'team' ? members.filter((m) => m.teamId === s.granteeId) : undefined,
    }))
  })

  app.delete<{ Params: { id: string; shareId: string } }>(
    '/vaults/:id/shares/:shareId',
    async (req, reply) => {
      const vaultId = req.params.id
      if (!(await requireOwner(req.user!.id, vaultId))) {
        return reply.code(404).send({ error: 'not found' })
      }
      const [share] = await db
        .delete(vaultShares)
        .where(and(eq(vaultShares.id, req.params.shareId), eq(vaultShares.vaultId, vaultId)))
        .returning()
      if (!share) return reply.code(404).send({ error: 'share not found' })
      const vault = (await db.select().from(vaults).where(eq(vaults.id, vaultId)))[0]!
      if (share.granteeType === 'user') {
        await notify({
          recipientId: share.granteeId,
          type: 'vault_share_revoked',
          entityType: 'vault',
          entityId: vaultId,
          message: `Your access to vault "${vault.name}" was revoked.`,
        })
      }
      await logSecurityEvent({
        type: 'vault_share_revoked',
        actorUserId: req.user!.id,
        detail: { vaultId, shareId: share.id },
      })
      return { status: 'revoked' }
    },
  )

  app.post<{ Params: { id: string }; Body: { newOwnerId: string } }>(
    '/vaults/:id/transfer',
    {
      schema: {
        body: {
          type: 'object',
          required: ['newOwnerId'],
          properties: { newOwnerId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (req, reply) => {
      if (!(await requireOwner(req.user!.id, req.params.id))) {
        return reply.code(404).send({ error: 'not found' })
      }
      const newOwner = (
        await db.select().from(users).where(eq(users.id, req.body.newOwnerId))
      )[0]
      if (!newOwner || newOwner.status !== 'active') {
        return reply.code(400).send({ error: 'new owner must be an active user' })
      }
      const [vault] = await db
        .update(vaults)
        .set({ ownerId: newOwner.id })
        .where(eq(vaults.id, req.params.id))
        .returning()
      await logSecurityEvent({
        type: 'vault_ownership_transferred',
        actorUserId: req.user!.id,
        subjectUserId: newOwner.id,
        detail: { vaultId: vault!.id },
      })
      return { ownerId: newOwner.id }
    },
  )

  app.put<{ Params: { id: string }; Body: { include: boolean } }>(
    '/vaults/:id/graph-preference',
    {
      schema: {
        body: {
          type: 'object',
          required: ['include'],
          properties: { include: { type: 'boolean' } },
        },
      },
    },
    async (req, reply) => {
      // Hardening: setting a preference requires current access — the
      // toggle must not be usable to probe vault IDs.
      const access = await resolveAccess(req.user!.id, req.params.id)
      if (!access) return reply.code(404).send({ error: 'not found' })
      await db
        .insert(vaultGraphPreferences)
        .values({ userId: req.user!.id, vaultId: req.params.id, include: req.body.include })
        .onConflictDoUpdate({
          target: [vaultGraphPreferences.userId, vaultGraphPreferences.vaultId],
          set: { include: req.body.include },
        })
      return { include: req.body.include }
    },
  )
}
