import type { FastifyInstance } from 'fastify'
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  graphPerspectives,
  repositories,
  repositoryGraphPreferences,
  vaultGraphPreferences,
  vaults,
} from '../db/schema.js'
import { atLeast, listAccessibleVaults, resolveAccess } from '../vaults/permissions.js'
import { listAccessibleRepositories } from '../repositories/permissions.js'
import { buildGraph, findShortestPath } from './assemble.js'
import { graphQuerySchema, parseGraphFilters, type GraphQuery } from './filters.js'

async function resolveMergedResources(userId: string): Promise<{ vaultIds: string[]; repositoryIds: string[] }> {
  const accessibleVaults = await listAccessibleVaults(userId)
  const accessibleVaultIds = accessibleVaults.map((v) => v.id)
  const accessibleRepos = await listAccessibleRepositories(userId)
  const accessibleRepoIds = accessibleRepos.map((r) => r.id)
  if (accessibleVaultIds.length === 0 && accessibleRepoIds.length === 0) {
    return { vaultIds: [], repositoryIds: [] }
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
            eq(vaultGraphPreferences.userId, userId),
          ),
        )
        .where(
          and(
            eq(vaults.mergeable, true),
            inArray(vaults.id, accessibleVaultIds),
          ),
        )
    : []

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
            eq(repositoryGraphPreferences.userId, userId),
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
    .filter((v) => v.include === true || (v.include === null && v.ownerId === userId))
    .map((v) => v.vaultId)

  const includedRepoIds = repoPrefs
    .filter((r) => r.include === true || (r.include === null && r.ownerId === userId))
    .map((r) => r.repositoryId)

  return { vaultIds: includedVaultIds, repositoryIds: includedRepoIds }
}

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

  app.get<{
    Params: { id: string }
    Querystring: { source?: string; target?: string }
  }>(
    '/vaults/:id/graph/path',
    async (req, reply) => {
      const access = await resolveAccess(req.user!.id, req.params.id)
      if (!atLeast(access, 'read')) return reply.code(404).send({ error: 'not found' })
      const { source, target } = req.query
      if (!source || !target) return reply.code(400).send({ error: 'source and target required' })
      const graph = await buildGraph({ vaultIds: [req.params.id], repositoryIds: [] })
      const sNode = graph.nodes.find((n) => n.id === source || n.path === source)
      const tNode = graph.nodes.find((n) => n.id === target || n.path === target)
      if (!sNode || !tNode) return reply.code(404).send({ error: 'Source or target node not found in graph' })
      return findShortestPath(graph, sNode.id, tNode.id)
    },
  )

  app.get<{
    Querystring: GraphQuery
  }>(
    '/graph/merged',
    { schema: { querystring: graphQuerySchema } },
    async (req) => {
      const resources = await resolveMergedResources(req.user!.id)
      return buildGraph(resources, parseGraphFilters(req.query))
    },
  )

  app.get<{
    Querystring: { source?: string; target?: string }
  }>(
    '/graph/merged/path',
    async (req, reply) => {
      const { source, target } = req.query
      if (!source || !target) return reply.code(400).send({ error: 'source and target required' })
      const resources = await resolveMergedResources(req.user!.id)
      const graph = await buildGraph(resources)
      const sNode = graph.nodes.find((n) => n.id === source || n.path === source)
      const tNode = graph.nodes.find((n) => n.id === target || n.path === target)
      if (!sNode || !tNode) return reply.code(404).send({ error: 'Source or target node not found in graph' })
      return findShortestPath(graph, sNode.id, tNode.id)
    },
  )

  app.get<{
    Querystring: { vaultId?: string }
  }>(
    '/graph/perspectives',
    async (req, reply) => {
      const { vaultId } = req.query
      if (vaultId) {
        const access = await resolveAccess(req.user!.id, vaultId)
        if (!atLeast(access, 'read')) return reply.code(404).send({ error: 'not found' })
        return db
          .select()
          .from(graphPerspectives)
          .where(
            and(
              eq(graphPerspectives.vaultId, vaultId),
              or(
                eq(graphPerspectives.userId, req.user!.id),
                eq(graphPerspectives.isShared, true),
              ),
            ),
          )
          .orderBy(asc(graphPerspectives.createdAt))
      }

      return db
        .select()
        .from(graphPerspectives)
        .where(
          and(
            isNull(graphPerspectives.vaultId),
            or(
              eq(graphPerspectives.userId, req.user!.id),
              eq(graphPerspectives.isShared, true),
            ),
          ),
        )
        .orderBy(asc(graphPerspectives.createdAt))
    },
  )

  app.post<{
    Body: {
      name: string
      vaultId?: string | null
      filters?: {
        types?: string[]
        tags?: string[]
        since?: string
        until?: string
        colorMode?: string
      }
      isShared?: boolean
    }
  }>(
    '/graph/perspectives',
    async (req, reply) => {
      const { name, vaultId, filters, isShared } = req.body ?? {}
      if (!name || !name.trim()) {
        return reply.code(400).send({ error: 'name is required' })
      }
      if (vaultId) {
        const access = await resolveAccess(req.user!.id, vaultId)
        if (!atLeast(access, 'read')) return reply.code(404).send({ error: 'not found' })
      }

      const [created] = await db
        .insert(graphPerspectives)
        .values({
          name: name.trim(),
          vaultId: vaultId || null,
          userId: req.user!.id,
          filters: filters ?? {},
          isShared: isShared ?? true,
        })
        .returning()

      return reply.code(201).send(created)
    },
  )

  app.delete<{
    Params: { id: string }
  }>(
    '/graph/perspectives/:id',
    async (req, reply) => {
      const [perspective] = await db
        .select()
        .from(graphPerspectives)
        .where(eq(graphPerspectives.id, req.params.id))
      if (!perspective) return reply.code(404).send({ error: 'not found' })

      if (perspective.userId !== req.user!.id) {
        if (perspective.vaultId) {
          const access = await resolveAccess(req.user!.id, perspective.vaultId)
          if (access !== 'owner') return reply.code(403).send({ error: 'forbidden' })
        } else {
          return reply.code(403).send({ error: 'forbidden' })
        }
      }

      await db.delete(graphPerspectives).where(eq(graphPerspectives.id, req.params.id))
      return reply.code(200).send({ ok: true })
    },
  )
}

