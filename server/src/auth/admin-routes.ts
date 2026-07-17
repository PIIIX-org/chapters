import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { teamMemberships, users, vaults, vaultShares } from '../db/schema.js'
import { destroyUserSessions } from './sessions.js'
import { logSecurityEvent } from './security-events.js'
import { notify } from '../notifications/notify.js'

export function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAdmin)

  app.get<{ Querystring: { status?: 'pending_approval' | 'active' | 'deactivated' } }>(
    '/users',
    async (req) => {
      const base = db
        .select({
          id: users.id,
          email: users.email,
          status: users.status,
          role: users.role,
          createdAt: users.createdAt,
        })
        .from(users)
      const rows = req.query.status
        ? await base.where(eq(users.status, req.query.status))
        : await base
      return rows
    },
  )

  app.post<{ Params: { id: string } }>('/users/:id/approve', async (req, reply) => {
    const [user] = await db
      .update(users)
      .set({ status: 'active' })
      .where(and(eq(users.id, req.params.id), eq(users.status, 'pending_approval')))
      .returning()
    if (!user) return reply.code(404).send({ error: 'no pending user' })
    await logSecurityEvent({
      type: 'user_approved',
      actorUserId: req.user!.id,
      subjectUserId: user.id,
    })
    await notify({
      recipientId: user.id,
      type: 'signup_approved',
      message: 'Your Chapters account has been approved. You can now log in.',
    })
    return { status: 'active' }
  })

  app.post<{ Params: { id: string } }>('/users/:id/promote', async (req, reply) => {
    const [user] = await db
      .update(users)
      .set({ role: 'admin' })
      .where(eq(users.id, req.params.id))
      .returning()
    if (!user) return reply.code(404).send({ error: 'user not found' })
    await logSecurityEvent({
      type: 'admin_promoted',
      actorUserId: req.user!.id,
      subjectUserId: user.id,
    })
    return { role: 'admin' }
  })

  app.post<{ Params: { id: string } }>('/users/:id/deactivate', async (req, reply) => {
    const [user] = await db
      .update(users)
      .set({ status: 'deactivated' })
      .where(eq(users.id, req.params.id))
      .returning()
    if (!user) return reply.code(404).send({ error: 'user not found' })
    // Cascade cleanup per spec hardening: sessions, memberships, direct shares.
    await destroyUserSessions(user.id)
    await db.delete(teamMemberships).where(eq(teamMemberships.userId, user.id))
    await db
      .delete(vaultShares)
      .where(and(eq(vaultShares.granteeType, 'user'), eq(vaultShares.granteeId, user.id)))
    await logSecurityEvent({
      type: 'user_deactivated',
      actorUserId: req.user!.id,
      subjectUserId: user.id,
    })
    await notify({
      recipientId: user.id,
      type: 'account_status_changed',
      message: 'Your Chapters account has been deactivated by an admin.',
    })
    return { status: 'deactivated' }
  })

  app.post<{ Params: { id: string }; Body: { newOwnerId: string } }>(
    '/vaults/:id/transfer-owner',
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
      if (!vault) return reply.code(404).send({ error: 'vault not found' })
      await logSecurityEvent({
        type: 'vault_ownership_transferred',
        actorUserId: req.user!.id,
        subjectUserId: newOwner.id,
        detail: { vaultId: vault.id },
      })
      await notify({
        recipientId: newOwner.id,
        type: 'vault_shared',
        entityType: 'vault',
        entityId: vault.id,
        message: `You are now the owner of vault "${vault.name}".`,
      })
      return { ownerId: newOwner.id }
    },
  )
}
