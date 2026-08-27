import type { FastifyInstance } from 'fastify'
import { resolveRepositoryAccess } from './permissions.js'
import { getRepositoryFile, listFileSymbols } from './store.js'

/**
 * Addition 3 — one file's text, for the read-only viewer.
 *
 * `path` travels as a query param rather than a wildcard segment: repository
 * paths have arbitrary depth, and a wildcard would collide with
 * `/repositories/:id/files`. Symbols ship *with* the content so the outline
 * costs no second request and can never disagree with the text beside it.
 */
export function repositoryFileContentRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth)

  app.get<{ Params: { id: string }; Querystring: { path: string } }>(
    '/repositories/:id/files/content',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['path'],
          properties: { path: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (req, reply) => {
      // Owner or viewer, resolved live per request.
      const access = await resolveRepositoryAccess(req.user!.id, req.params.id)
      if (!access) return reply.code(404).send({ error: 'not found' })

      const file = await getRepositoryFile(req.params.id, req.query.path)
      // Identical 404 to an unreachable repository — a distinguishable
      // response would let a viewer probe repository ids.
      if (!file) return reply.code(404).send({ error: 'not found' })

      return {
        id: file.id,
        path: file.path,
        language: file.language,
        size: file.size,
        contentHash: file.contentHash,
        content: file.content,
        sourceModifiedAt: file.sourceModifiedAt,
        updatedAt: file.updatedAt,
        symbols: await listFileSymbols(file.id),
      }
    },
  )
}
