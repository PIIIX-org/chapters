import type { FastifyInstance } from 'fastify'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { repositories, repositoryGraphPreferences, vaultGraphPreferences, vaults } from '../db/schema.js'
import { atLeast, listAccessibleVaults, resolveAccess } from '../vaults/permissions.js'
import { listAccessibleRepositories } from '../repositories/permissions.js'
import { buildGraph } from './assemble.js'
import { graphQuerySchema, parseGraphFilters, type GraphQuery } from './filters.js'

export function graphRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth)

  app.get<{
    Params: { id: string }
    Querystring: GraphQuery
  }>(
    '/vaults/:id/graph',
    { schema: { querystring: graphQuerySchema } },
    async (req, reply) => {
      const access = await resolveAccess(req.user!.id, req.params.id)
      if (!atLeast(access, 'read')) return reply.code(404).send({ error: 'not found' })
      return buildGraph({ vaultIds: [req.params.id], repositoryIds: [] }, parseGraphFilters(req.query))
    },
  )

  /**
   * Merged cross-vault view. Candidate set re-resolved live on every
   * request (audit rule): my preference ∩ owner's mergeable gate ∩ my
   * current access — a stale preference never surfaces anything.
   */
  app.get<{
    Querystring: GraphQuery
  }>(
    '/graph/merged',
    { schema: { querystring: graphQuerySchema } },
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
            .select({
              vaultId: vaults.id,
              ownerId: vaults.ownerId,
              include: vaultGraphPreferences.include,
            })
            .from(vaults)
            .leftJoin(
              vaultGraphPreferences,
              and(
                eq(vaultGraphPreferences.vaultId, vaults.id),
                eq(vaultGraphPreferences.userId, req.user!.id),
              ),
            )
            .where(
              and(
                eq(vaults.mergeable, true),
                inArray(vaults.id, accessibleVaultIds),
              ),
            )
        : []
      // Same preference ∩ mergeable ∩ live-access rule as vaults (spec 8).
      const repoPrefs = accessibleRepoIds.length
        ? await db
            .select({
              repositoryId: repositories.id,
              ownerId: repositories.ownerId,
              include: repositoryGraphPreferences.include,
            })
            .from(repositories)
            .leftJoin(
              repositoryGraphPreferences,
              and(
                eq(repositoryGraphPreferences.repositoryId, repositories.id),
                eq(repositoryGraphPreferences.userId, req.user!.id),
              ),
            )
            .where(
              and(
                eq(repositories.mergeable, true),
                inArray(repositories.id, accessibleRepoIds),
              ),
            )
        : []

      const includedVaultIds = vaultPrefs
        .filter((v) => v.include === true || (v.include === null && v.ownerId === req.user!.id))
        .map((v) => v.vaultId)

      const includedRepoIds = repoPrefs
        .filter((r) => r.include === true || (r.include === null && r.ownerId === req.user!.id))
        .map((r) => r.repositoryId)

      return buildGraph(
        {
          vaultIds: includedVaultIds,
          repositoryIds: includedRepoIds,
        },
        parseGraphFilters(req.query),
      )
    },
  )
}
