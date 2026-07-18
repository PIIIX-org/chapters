import type { FastifyInstance } from 'fastify'
import { atLeast, listAccessibleVaults, resolveAccess } from '../vaults/permissions.js'
import { listAccessibleRepositories } from '../repositories/permissions.js'
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

  /**
   * "Search everywhere": every vault and repository the caller can
   * currently reach — not gated by mergeable/graph-preference, a
   * deliberately different (broader) scope than the merged graph view.
   */
  app.get<{ Querystring: { q: string; limit?: number } }>(
    '/search',
    { schema: { querystring: searchQuerySchema } },
    async (req) => {
      const [accessibleVaults, accessibleRepos] = await Promise.all([
        listAccessibleVaults(req.user!.id),
        listAccessibleRepositories(req.user!.id),
      ])
      return searchNotes(
        {
          vaultIds: accessibleVaults.map((v) => v.id),
          repositoryIds: accessibleRepos.map((r) => r.id),
        },
        req.query.q,
        req.query.limit,
      )
    },
  )
}
