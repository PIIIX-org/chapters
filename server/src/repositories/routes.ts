import { resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  repositories,
  repositoryGraphPreferences,
  repositoryShares,
  teamMemberships,
  teams,
  users,
} from '../db/schema.js'
import { config } from '../config.js'
import { logSecurityEvent } from '../auth/security-events.js'
import { encryptCredential } from './credentials.js'
import { generateToken } from '../auth/tokens.js'
import { listAccessibleRepositories, resolveRepositoryAccess } from './permissions.js'
import { createSyncToken, listSyncTokens, revokeSyncToken } from './sync-tokens.js'
import { listRepositoryFiles } from './store.js'
import { buildGraph, type GraphFilters } from '../graph/assemble.js'
import { searchNotes } from '../search/search.js'

function parseGraphFilters(q: {
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

async function requireOwner(userId: string, repositoryId: string): Promise<boolean> {
  return (await resolveRepositoryAccess(userId, repositoryId)) === 'owner'
}

function repositoryView(repo: typeof repositories.$inferSelect) {
  return {
    id: repo.id,
    name: repo.name,
    ownerId: repo.ownerId,
    ingestionMethod: repo.ingestionMethod,
    gitUrl: repo.gitUrl,
    localPath: repo.localPath,
    mergeable: repo.mergeable,
    syncStatus: repo.syncStatus,
    lastSyncedAt: repo.lastSyncedAt,
    lastSyncError: repo.lastSyncError,
    createdAt: repo.createdAt,
  }
}

function isWithinLocalReposRoot(candidate: string): boolean {
  const root = resolve(config.localReposRoot)
  const resolved = resolve(root, candidate)
  return resolved === root || resolved.startsWith(root + '/')
}

export function repositoryRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth)

  app.post<{
    Body: {
      name: string
      ingestionMethod: 'git' | 'local_path' | 'agent_push'
      gitUrl?: string
      gitCredential?: string
      localPath?: string
    }
  }>(
    '/repositories',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'ingestionMethod'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            ingestionMethod: { enum: ['git', 'local_path', 'agent_push'] },
            gitUrl: { type: 'string', minLength: 1 },
            gitCredential: { type: 'string', minLength: 1 },
            localPath: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      const { name, ingestionMethod, gitUrl, gitCredential, localPath } = req.body

      if (ingestionMethod === 'git' && !gitUrl) {
        return reply.code(400).send({ error: 'gitUrl is required for the git ingestion method' })
      }
      if (ingestionMethod === 'local_path') {
        if (!localPath) {
          return reply.code(400).send({ error: 'localPath is required for the local_path ingestion method' })
        }
        if (!isWithinLocalReposRoot(localPath)) {
          return reply.code(400).send({ error: 'localPath must resolve under the configured local repos root' })
        }
      }

      let gitCredentialEncrypted: string | undefined
      if (gitCredential) {
        try {
          gitCredentialEncrypted = encryptCredential(gitCredential)
        } catch (err) {
          return reply.code(400).send({ error: (err as Error).message })
        }
      }

      const [repo] = await db
        .insert(repositories)
        .values({
          name,
          ownerId: req.user!.id,
          ingestionMethod,
          gitUrl: ingestionMethod === 'git' ? gitUrl : undefined,
          gitCredentialEncrypted,
          localPath: ingestionMethod === 'local_path' ? resolve(config.localReposRoot, localPath!) : undefined,
        })
        .returning()

      // Never echo the credential back — created-once, write-only from here.
      return repositoryView(repo!)
    },
  )

  app.get('/repositories', async (req) => listAccessibleRepositories(req.user!.id))

  app.get<{ Params: { id: string } }>('/repositories/:id/access', async (req, reply) => {
    const access = await resolveRepositoryAccess(req.user!.id, req.params.id)
    if (!access) return reply.code(404).send({ error: 'not found' })
    return { access }
  })

  app.patch<{ Params: { id: string }; Body: { name?: string; mergeable?: boolean } }>(
    '/repositories/:id',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            mergeable: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      if (!(await requireOwner(req.user!.id, req.params.id))) {
        return reply.code(404).send({ error: 'not found' })
      }
      const [repo] = await db
        .update(repositories)
        .set(req.body)
        .where(eq(repositories.id, req.params.id))
        .returning()
      return repositoryView(repo!)
    },
  )

  app.delete<{ Params: { id: string } }>('/repositories/:id', async (req, reply) => {
    if (!(await requireOwner(req.user!.id, req.params.id))) {
      return reply.code(404).send({ error: 'not found' })
    }
    await db.delete(repositories).where(eq(repositories.id, req.params.id))
    return { status: 'deleted' }
  })

  app.post<{
    Params: { id: string }
    Body: { granteeType: 'user' | 'team'; granteeId: string }
  }>(
    '/repositories/:id/shares',
    {
      schema: {
        body: {
          type: 'object',
          required: ['granteeType', 'granteeId'],
          properties: {
            granteeType: { enum: ['user', 'team'] },
            granteeId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (req, reply) => {
      const repositoryId = req.params.id
      if (!(await requireOwner(req.user!.id, repositoryId))) {
        return reply.code(404).send({ error: 'not found' })
      }
      const { granteeType, granteeId } = req.body
      if (granteeType === 'user') {
        const grantee = (await db.select().from(users).where(eq(users.id, granteeId)))[0]
        if (!grantee || grantee.status !== 'active') {
          return reply.code(400).send({ error: 'grantee must be an active user' })
        }
      } else {
        const team = (await db.select().from(teams).where(eq(teams.id, granteeId)))[0]
        if (!team) return reply.code(400).send({ error: 'team not found' })
      }
      const [share] = await db
        .insert(repositoryShares)
        .values({ repositoryId, granteeType, granteeId })
        .onConflictDoNothing()
        .returning()
      await logSecurityEvent({
        type: 'repository_share_created',
        actorUserId: req.user!.id,
        detail: { repositoryId, granteeType, granteeId },
      })
      return share ?? { status: 'already_shared' }
    },
  )

  app.get<{ Params: { id: string } }>('/repositories/:id/shares', async (req, reply) => {
    const repositoryId = req.params.id
    if (!(await requireOwner(req.user!.id, repositoryId))) {
      return reply.code(404).send({ error: 'not found' })
    }
    const shares = await db
      .select()
      .from(repositoryShares)
      .where(eq(repositoryShares.repositoryId, repositoryId))
    const teamIds = shares.filter((s) => s.granteeType === 'team').map((s) => s.granteeId)
    const members = teamIds.length
      ? await db
          .select({
            teamId: teamMemberships.teamId,
            userId: teamMemberships.userId,
            email: users.email,
          })
          .from(teamMemberships)
          .innerJoin(users, eq(users.id, teamMemberships.userId))
          .where(inArray(teamMemberships.teamId, teamIds))
      : []
    return shares.map((s) => ({
      ...s,
      members: s.granteeType === 'team' ? members.filter((m) => m.teamId === s.granteeId) : undefined,
    }))
  })

  app.delete<{ Params: { id: string; shareId: string } }>(
    '/repositories/:id/shares/:shareId',
    async (req, reply) => {
      const repositoryId = req.params.id
      if (!(await requireOwner(req.user!.id, repositoryId))) {
        return reply.code(404).send({ error: 'not found' })
      }
      const [share] = await db
        .delete(repositoryShares)
        .where(
          and(eq(repositoryShares.id, req.params.shareId), eq(repositoryShares.repositoryId, repositoryId)),
        )
        .returning()
      if (!share) return reply.code(404).send({ error: 'share not found' })
      await logSecurityEvent({
        type: 'repository_share_revoked',
        actorUserId: req.user!.id,
        detail: { repositoryId, shareId: share.id },
      })
      return { status: 'revoked' }
    },
  )

  app.get<{
    Params: { id: string }
    Querystring: { types?: string; tags?: string; since?: string; until?: string }
  }>('/repositories/:id/graph', async (req, reply) => {
    const access = await resolveRepositoryAccess(req.user!.id, req.params.id)
    if (!access) return reply.code(404).send({ error: 'not found' })
    return buildGraph(
      { vaultIds: [], repositoryIds: [req.params.id] },
      parseGraphFilters(req.query),
    )
  })

  app.get<{ Params: { id: string }; Querystring: { q: string; limit?: number } }>(
    '/repositories/:id/search',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['q'],
          properties: {
            q: { type: 'string', minLength: 1, maxLength: 500 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    async (req, reply) => {
      const access = await resolveRepositoryAccess(req.user!.id, req.params.id)
      if (!access) return reply.code(404).send({ error: 'not found' })
      return searchNotes({ vaultIds: [], repositoryIds: [req.params.id] }, req.query.q, req.query.limit)
    },
  )

  app.get<{ Params: { id: string } }>('/repositories/:id/files', async (req, reply) => {
    const access = await resolveRepositoryAccess(req.user!.id, req.params.id)
    if (!access) return reply.code(404).send({ error: 'not found' })
    return listRepositoryFiles(req.params.id)
  })

  app.post<{ Params: { id: string } }>('/repositories/:id/webhook-secret', async (req, reply) => {
    if (!(await requireOwner(req.user!.id, req.params.id))) {
      return reply.code(404).send({ error: 'not found' })
    }
    const repo = (await db.select().from(repositories).where(eq(repositories.id, req.params.id)))[0]!
    if (repo.ingestionMethod !== 'git') {
      return reply.code(400).send({ error: 'webhooks only apply to git-sourced repositories' })
    }
    const secret = generateToken()
    await db
      .update(repositories)
      .set({ webhookSecretEncrypted: encryptCredential(secret) })
      .where(eq(repositories.id, req.params.id))
    // Shown exactly once — configure it on the git host's webhook settings now.
    return { secret, webhookPath: `/repositories/${req.params.id}/webhook` }
  })

  app.post<{ Params: { id: string } }>('/repositories/:id/sync-tokens', async (req, reply) => {
    if (!(await requireOwner(req.user!.id, req.params.id))) {
      return reply.code(404).send({ error: 'not found' })
    }
    const token = await createSyncToken(req.params.id)
    // Shown exactly once, same pattern as MCP connection tokens.
    return { token }
  })

  app.get<{ Params: { id: string } }>('/repositories/:id/sync-tokens', async (req, reply) => {
    if (!(await requireOwner(req.user!.id, req.params.id))) {
      return reply.code(404).send({ error: 'not found' })
    }
    return listSyncTokens(req.params.id)
  })

  app.post<{ Params: { id: string; tokenId: string } }>(
    '/repositories/:id/sync-tokens/:tokenId/revoke',
    async (req, reply) => {
      if (!(await requireOwner(req.user!.id, req.params.id))) {
        return reply.code(404).send({ error: 'not found' })
      }
      const revoked = await revokeSyncToken(req.params.id, req.params.tokenId)
      if (!revoked) return reply.code(404).send({ error: 'token not found' })
      return { status: 'revoked' }
    },
  )

  app.put<{ Params: { id: string }; Body: { include: boolean } }>(
    '/repositories/:id/graph-preference',
    {
      schema: {
        body: {
          type: 'object',
          required: ['include'],
          properties: { include: { type: 'boolean' } },
        },
      },
    },
    async (req, reply) => {
      // Requires current access — the toggle must not probe repository IDs.
      const access = await resolveRepositoryAccess(req.user!.id, req.params.id)
      if (!access) return reply.code(404).send({ error: 'not found' })
      await db
        .insert(repositoryGraphPreferences)
        .values({ userId: req.user!.id, repositoryId: req.params.id, include: req.body.include })
        .onConflictDoUpdate({
          target: [repositoryGraphPreferences.userId, repositoryGraphPreferences.repositoryId],
          set: { include: req.body.include },
        })
      return { include: req.body.include }
    },
  )
}
