import type { FastifyInstance } from 'fastify'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { notifications } from '../db/schema.js'

export function notificationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth)

  app.get<{ Querystring: { limit?: number; offset?: number } }>(
    '/notifications',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
            offset: { type: 'integer', minimum: 0, default: 0 },
          },
        },
      },
    },
    async (req) => {
      return db
        .select()
        .from(notifications)
        .where(eq(notifications.recipientId, req.user!.id))
        .orderBy(desc(notifications.createdAt))
        .limit(req.query.limit ?? 50)
        .offset(req.query.offset ?? 0)
    },
  )

  app.post<{ Params: { id: string } }>('/notifications/:id/read', async (req, reply) => {
    const [row] = await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.id, req.params.id),
          eq(notifications.recipientId, req.user!.id),
          isNull(notifications.readAt),
        ),
      )
      .returning()
    if (!row) return reply.code(404).send({ error: 'notification not found' })
    return { status: 'read' }
  })
}
