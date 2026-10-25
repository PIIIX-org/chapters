import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { repositories } from '../db/schema.js'
import { resolveSyncToken } from './sync-tokens.js'
import { syncRepositoryFiles } from './store.js'

interface PushBody {
  files: Array<{ path: string; content: string }>
  currentPaths: string[]
  /** The commit the pushed files are, if they are one (#471); absent clears it. */
  commit?: string
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
      // File content may hold NULs (binary-ish files): syncRepositoryFiles
      // strips them and hashes the bytes as sent. Paths are still refused (#443).
      config: { nulBytesAllowed: ['files.*.content'] },
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
            // A git object name: SHA-1 (40) or SHA-256 (64) hex.
            commit: { type: 'string', pattern: '^([0-9a-f]{40}|[0-9a-f]{64})$' },
          },
        },
      },
    },
    async (req, reply) => {
      const header = req.headers.authorization
      const token = header?.startsWith('Bearer ') ? header.slice(7) : null
      const auth = token ? await resolveSyncToken(token) : null
      if (!auth) return reply.code(401).send({ error: 'invalid or revoked sync token' })

      const result = await syncRepositoryFiles(auth.repositoryId, req.body.files, req.body.currentPaths, {
        commit: req.body.commit ?? null,
      })
      await db
        .update(repositories)
        .set({ syncStatus: 'idle', lastSyncedAt: new Date(), lastSyncError: null })
        .where(eq(repositories.id, auth.repositoryId))
      return result
    },
  )
}
