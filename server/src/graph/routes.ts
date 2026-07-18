import type { FastifyInstance } from 'fastify'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { repositories, repositoryGraphPreferences, vaultGraphPreferences, vaults } from '../db/schema.js'
import { atLeast, listAccessibleVaults, resolveAccess } from '../vaults/permissions.js'
import { listAccessibleRepositories } from '../repositories/permissions.js'
import { buildGraph, type GraphFilters } from './assemble.js'

function parseFilters(q: {
  types?: string
  tags?: string
  since?: string
  until?: string
}): GraphFilters {
  return {
    types: q.types ? q.types.split(',').filter(Boolean) : undefined,
    tags: q.tags ? q.tags.split(',').filter(Boolean) : undefined,
    since: q.since,
    until: q.until,
  }
}

const filterQuerySchema = {
  type: 'object',
  properties: {
    types: { type: 'string' },
    tags: { type: 'string' },
    since: { type: 'string' },
    until: { type: 'string' },
  },
} as const

export function graphRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth)

  app.get<{
    Params: { id: string }
    Querystring: { types?: string; tags?: string; since?: string; until?: string }
  }>(
    '/vaults/:id/graph',
    { schema: { querystring: filterQuerySchema } },
    async (req, reply) => {
      const access = await resolveAccess(req.user!.id, req.params.id)
      if (!atLeast(access, 'read')) return reply.code(404).send({ error: 'not found' })
      return buildGraph({ vaultIds: [req.params.id], repositoryIds: [] }, parseFilters(req.query))
    },
  )

  /**
   * Merged cross-vault view. Candidate set re-resolved live on every
   * request (audit rule): my preference ∩ owner's mergeable gate ∩ my
   * current access — a stale preference never surfaces anything.
   */
  app.get<{ Querystring: { types?: string; tags?: string; since?: string; until?: string } }>(
    '/graph/merged',
    { schema: { querystring: filterQuerySchema } },
    async (req) => {
      const accessibleVaults = await listAccessibleVaults(req.user!.id)
      const accessibleVaultIds = accessibleVaults.map((v) => v.id)
      const accessibleRepos = await listAccessibleRepositories(req.user!.id)
      const accessibleRepoIds = accessibleRepos.map((r) => r.id)
      if (accessibleVaultIds.length === 0 && accessibleRepoIds.length === 0) {
        return buildGraph({ vaultIds: [], repositoryIds: [] })
      }

      const vaultPrefs = accessibleVaultIds.length
        ? await db
            .select({ vaultId: vaultGraphPreferences.vaultId })
            .from(vaultGraphPreferences)
            .innerJoin(vaults, eq(vaults.id, vaultGraphPreferences.vaultId))
            .where(
              and(
                eq(vaultGraphPreferences.userId, req.user!.id),
                eq(vaultGraphPreferences.include, true),
                eq(vaults.mergeable, true),
                inArray(vaultGraphPreferences.vaultId, accessibleVaultIds),
              ),
            )
        : []
      // Same preference ∩ mergeable ∩ live-access rule as vaults (spec 8).
      const repoPrefs = accessibleRepoIds.length
        ? await db
            .select({ repositoryId: repositoryGraphPreferences.repositoryId })
            .from(repositoryGraphPreferences)
            .innerJoin(repositories, eq(repositories.id, repositoryGraphPreferences.repositoryId))
            .where(
              and(
                eq(repositoryGraphPreferences.userId, req.user!.id),
                eq(repositoryGraphPreferences.include, true),
                eq(repositories.mergeable, true),
                inArray(repositoryGraphPreferences.repositoryId, accessibleRepoIds),
              ),
            )
        : []

      return buildGraph(
        {
          vaultIds: vaultPrefs.map((p) => p.vaultId),
          repositoryIds: repoPrefs.map((p) => p.repositoryId),
        },
        parseFilters(req.query),
      )
    },
  )
}
