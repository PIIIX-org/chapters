import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { repositories } from '../db/schema.js'
import { resolveSyncToken } from './sync-tokens.js'
import { syncRepositoryFiles } from './store.js'

interface PushBody {
  files: Array<{ path: string; content: string }>
  currentPaths: string[]
}

/**
 * Agent/CLI push ingestion (spec 8): a client that already has the
 * repository checked out locally sends changed files directly — no
 * clone, no watcher, the closest analog to how Graphify itself
 * operates (parse where the code already is).
 */
export function repositoryPushRoutes(app: FastifyInstance) {
  app.post<{ Body: PushBody }>(
    '/repositories/sync',
    {
      schema: {
        body: {
          type: 'object',
          required: ['files', 'currentPaths'],
          properties: {
            files: {
              type: 'array',
              items: {
                type: 'object',
                required: ['path', 'content'],
                properties: {
                  path: { type: 'string', minLength: 1 },
                  content: { type: 'string' },
                },
              },
            },
            currentPaths: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    async (req, reply) => {
      const header = req.headers.authorization
      const token = header?.startsWith('Bearer ') ? header.slice(7) : null
      const auth = token ? await resolveSyncToken(token) : null
      if (!auth) return reply.code(401).send({ error: 'invalid or revoked sync token' })

      const result = await syncRepositoryFiles(auth.repositoryId, req.body.files, req.body.currentPaths)
      await db
        .update(repositories)
        .set({ syncStatus: 'idle', lastSyncedAt: new Date(), lastSyncError: null })
        .where(eq(repositories.id, auth.repositoryId))
      return result
    },
  )
}
