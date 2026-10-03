import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { teamMemberships, users, vaults, vaultShares, type UserRole } from '../db/schema.js'
import { destroyUserSessions } from './sessions.js'
import { WELCOME_SUBJECT, WELCOME_TEXT } from '../email/welcome.js'
import { logSecurityEvent } from './security-events.js'
import { notify } from '../notifications/notify.js'
import { emitPermissionChange } from '../sync/permission-events.js'

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
          // Login needs `active` AND a verified email (routes.ts:169).
          // Without this column the approval queue cannot tell an admin that
          // approving this row still leaves the person locked out.
          emailVerifiedAt: users.emailVerifiedAt,
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
      message: 'Your Elara account has been approved. You can now log in.',
      emailSubject: WELCOME_SUBJECT,
      emailText: WELCOME_TEXT,
    })
    return { status: 'active' }
  })

  const ROLE_RANK: Record<string, number> = {
    owner: 100,
    superadmin: 90,
    admin: 80,
    moderator: 70,
    manager: 60,
    editor: 50,
    contributor: 40,
    member: 30,
    viewer: 20,
    guest: 10,
  }

  async function getTargetUser(id: string) {
    const [user] = await db.select().from(users).where(eq(users.id, id))
    return user ?? null
  }

  app.post<{ Params: { id: string }; Body: { role?: UserRole } }>('/users/:id/promote', async (req, reply) => {
    if (req.params.id === req.user!.id) {
      return reply.code(400).send({ error: 'cannot promote yourself' })
    }
    const target = await getTargetUser(req.params.id)
    if (!target) return reply.code(404).send({ error: 'user not found' })

    const targetRole = req.body?.role || 'admin'
    const callerRank = ROLE_RANK[req.user!.role] ?? 0
    const targetRoleRank = ROLE_RANK[targetRole] ?? 0

    if (target.role === 'owner') {
      return reply.code(403).send({ error: 'cannot modify the instance owner' })
    }
    if (target.role === 'superadmin' && req.user!.role !== 'owner') {
      return reply.code(403).send({ error: 'cannot modify a superadmin' })
    }
    if (targetRoleRank > callerRank) {
      return reply.code(403).send({ error: 'cannot grant a role higher than your own' })
    }

    const [user] = await db
      .update(users)
      .set({ role: targetRole })
      .where(eq(users.id, req.params.id))
      .returning()
    await logSecurityEvent({
      type: 'admin_promoted',
      actorUserId: req.user!.id,
      subjectUserId: user!.id,
      detail: { role: targetRole },
    })
    return { role: user!.role }
  })

  app.post<{ Params: { id: string }; Body: { role?: UserRole } }>('/users/:id/demote', async (req, reply) => {
    if (req.params.id === req.user!.id) {
      return reply.code(400).send({ error: 'cannot demote yourself' })
    }
    const target = await getTargetUser(req.params.id)
    if (!target) return reply.code(404).send({ error: 'user not found' })

    if (target.role === 'owner') {
      return reply.code(403).send({ error: 'cannot demote the instance owner' })
    }
    if (target.role === 'superadmin' && req.user!.role !== 'owner') {
      return reply.code(403).send({ error: 'cannot demote a superadmin' })
    }

    const targetRole = req.body?.role || 'member'
    const [user] = await db
      .update(users)
      .set({ role: targetRole })
      .where(eq(users.id, req.params.id))
      .returning()
    await logSecurityEvent({
      type: 'admin_demoted',
      actorUserId: req.user!.id,
      subjectUserId: user!.id,
      detail: { role: targetRole },
    })
    return { role: user!.role }
  })

  app.post<{ Params: { id: string }; Body: { role: UserRole } }>('/users/:id/role', async (req, reply) => {
    if (req.params.id === req.user!.id) {
      return reply.code(400).send({ error: 'cannot change your own role' })
    }
    if (!req.body?.role) {
      return reply.code(400).send({ error: 'role is required' })
    }
    const target = await getTargetUser(req.params.id)
    if (!target) return reply.code(404).send({ error: 'user not found' })

    if (target.role === 'owner') {
      return reply.code(403).send({ error: 'cannot modify the instance owner' })
    }
    if (target.role === 'superadmin' && req.user!.role !== 'owner') {
      return reply.code(403).send({ error: 'cannot modify a superadmin' })
    }
    const callerRank = ROLE_RANK[req.user!.role] ?? 0
    const desiredRank = ROLE_RANK[req.body.role] ?? 0
    if (desiredRank > callerRank) {
      return reply.code(403).send({ error: 'cannot grant a role higher than your own' })
    }

    const [user] = await db
      .update(users)
      .set({ role: req.body.role })
      .where(eq(users.id, req.params.id))
      .returning()
    await logSecurityEvent({
      type: 'user_role_changed',
      actorUserId: req.user!.id,
      subjectUserId: user!.id,
      detail: { role: req.body.role },
    })
    return { role: user!.role }
  })

  app.post<{ Params: { id: string } }>('/users/:id/deactivate', async (req, reply) => {
    if (req.params.id === req.user!.id) {
      return reply.code(400).send({ error: 'cannot deactivate yourself' })
    }
    const target = await getTargetUser(req.params.id)
    if (!target) return reply.code(404).send({ error: 'user not found' })

    if (target.role === 'owner') {
      return reply.code(403).send({ error: 'cannot deactivate the instance owner' })
    }
    if (target.role === 'superadmin' && req.user!.role !== 'owner') {
      return reply.code(403).send({ error: 'cannot deactivate a superadmin' })
    }

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
    emitPermissionChange({ userIds: [user.id] })
    await notify({
      recipientId: user.id,
      type: 'account_status_changed',
      message: 'Your Elara account has been deactivated by an admin.',
    })
    return { status: 'deactivated' }
  })

  app.post<{ Params: { id: string } }>('/users/:id/reactivate', async (req, reply) => {
    const [user] = await db
      .update(users)
      .set({ status: 'active' })
      .where(and(eq(users.id, req.params.id), eq(users.status, 'deactivated')))
      .returning()
    if (!user) return reply.code(404).send({ error: 'deactivated user not found' })
    await logSecurityEvent({
      type: 'user_reactivated',
      actorUserId: req.user!.id,
      subjectUserId: user.id,
    })
    emitPermissionChange({ userIds: [user.id] })
    await notify({
      recipientId: user.id,
      type: 'account_status_changed',
      message: 'Your Elara account has been reactivated by an admin. You can now log in.',
    })
    return { status: 'active' }
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
