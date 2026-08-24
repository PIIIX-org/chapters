import type { FastifyInstance } from 'fastify'
import { atLeast, listAccessibleVaults, resolveAccess } from '../vaults/permissions.js'
import { listAccessibleRepositories } from '../repositories/permissions.js'
import { searchNotes } from './search.js'
import type { GraphFilters } from '../graph/assemble.js'

const searchQuerySchema = {
  type: 'object',
  required: ['q'],
  properties: {
    q: { type: 'string', minLength: 1, maxLength: 500 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    types: { type: 'string' },
    tags: { type: 'string' },
    since: { type: 'string' },
    until: { type: 'string' },
  },
} as const

interface SearchQuery {
  q: string
  limit?: number
  types?: string
  tags?: string
  since?: string
  until?: string
}

// Same wire format as parseFilters in graph/routes.ts — comma-separated lists.
function parseFilters(q: SearchQuery): GraphFilters {
  return {
    types: q.types ? q.types.split(',').filter(Boolean) : undefined,
    tags: q.tags ? q.tags.split(',').filter(Boolean) : undefined,
    since: q.since,
    until: q.until,
  }
}

export function searchRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth)

  app.get<{ Params: { id: string }; Querystring: SearchQuery }>(
    '/vaults/:id/search',
    { schema: { querystring: searchQuerySchema } },
    async (req, reply) => {
      const access = await resolveAccess(req.user!.id, req.params.id)
      if (!atLeast(access, 'read')) return reply.code(404).send({ error: 'not found' })
      return searchNotes(
        { vaultIds: [req.params.id], repositoryIds: [] },
        req.query.q,
        req.query.limit,
        parseFilters(req.query),
      )
    },
  )

  /**
   * "Search everywhere": every vault and repository the caller can
   * currently reach — not gated by mergeable/graph-preference, a
   * deliberately different (broader) scope than the merged graph view.
   */
  app.get<{ Querystring: SearchQuery }>(
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
        parseFilters(req.query),
      )
    },
  )
}
