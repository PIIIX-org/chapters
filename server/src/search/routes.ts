import type { FastifyInstance } from 'fastify'
import { atLeast, listAccessibleVaults, resolveAccess } from '../vaults/permissions.js'
import { listAccessibleRepositories, resolveRepositoryAccess } from '../repositories/permissions.js'
import { findSymbols, searchNotes } from './search.js'
import { parseSearchFilters, searchQuerySchema, type SearchQuery } from './filters.js'

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
        parseSearchFilters(req.query),
        { includeSymbols: req.query.symbols, accountId: req.user!.id },
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
        parseSearchFilters(req.query),
        { includeSymbols: req.query.symbols, accountId: req.user!.id },
      )
    },
  )

  /**
   * Fine-grained AST symbol retrieval across all accessible repositories.
   */
  app.get<{
    Querystring: { q: string; kind?: string; limit?: number }
  }>(
    '/symbols/search',
    async (req) => {
      const accessibleRepos = await listAccessibleRepositories(req.user!.id)
      return findSymbols(
        accessibleRepos.map((r) => r.id),
        req.query.q,
        { kind: req.query.kind, limit: req.query.limit, accountId: req.user!.id },
      )
    },
  )

  /**
   * Fine-grained AST symbol retrieval for a single repository.
   */
  app.get<{
    Params: { id: string }
    Querystring: { q: string; kind?: string; limit?: number }
  }>(
    '/repositories/:id/symbols/search',
    async (req, reply) => {
      const access = await resolveRepositoryAccess(req.user!.id, req.params.id)
      if (!access) return reply.code(404).send({ error: 'not found' })
      return findSymbols([req.params.id], req.query.q, { kind: req.query.kind, limit: req.query.limit, accountId: req.user!.id })
    },
  )
}
