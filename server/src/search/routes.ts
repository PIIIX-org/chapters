import type { FastifyInstance } from 'fastify'
import { atLeast, listAccessibleVaults, resolveAccess } from '../vaults/permissions.js'
import { searchNotes } from './search.js'

const searchQuerySchema = {
  type: 'object',
  required: ['q'],
  properties: {
    q: { type: 'string', minLength: 1, maxLength: 500 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  },
} as const

export function searchRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth)

  app.get<{ Params: { id: string }; Querystring: { q: string; limit?: number } }>(
    '/vaults/:id/search',
    { schema: { querystring: searchQuerySchema } },
    async (req, reply) => {
      const access = await resolveAccess(req.user!.id, req.params.id)
      if (!atLeast(access, 'read')) return reply.code(404).send({ error: 'not found' })
      return searchNotes({ vaultIds: [req.params.id], repositoryIds: [] }, req.query.q, req.query.limit)
    },
  )

  /** "Search everywhere": every vault the caller can currently reach. */
  app.get<{ Querystring: { q: string; limit?: number } }>(
    '/search',
    { schema: { querystring: searchQuerySchema } },
    async (req) => {
      const accessible = await listAccessibleVaults(req.user!.id)
      return searchNotes(
        { vaultIds: accessible.map((v) => v.id), repositoryIds: [] },
        req.query.q,
        req.query.limit,
      )
    },
  )
}
