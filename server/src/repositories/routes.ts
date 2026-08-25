import { resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { and, eq, inArray, ne } from 'drizzle-orm'
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
import {
  listAccessibleRepositories,
  repositoryFields as repositoryView,
  resolveRepositoryAccess,
} from './permissions.js'
import { createSyncToken, listSyncTokens, revokeSyncToken } from './sync-tokens.js'
import { syncGitRepository } from './git-sync.js'
import {
  stopWatchingLocalRepository,
  syncLocalRepository,
  watchLocalRepository,
} from './scheduler.js'
import { listRepositoryFiles } from './store.js'
import { buildGraph, type GraphFilters } from '../graph/assemble.js'
import { searchNotes } from '../search/search.js'

function parseGraphFilters(q: {
  types?: string
  tags?: string
  since?: string
  until?: string
  aggregate?: string
  community?: string
}): GraphFilters {
  return {
    types: q.types ? q.types.split(',').filter(Boolean) : undefined,
    tags: q.tags ? q.tags.split(',').filter(Boolean) : undefined,
    since: q.since,
    until: q.until,
    aggregate: q.aggregate === 'community' ? 'community' : undefined,
    community:
      q.community !== undefined && q.community !== '' && Number.isInteger(Number(q.community))
        ? Number(q.community)
        : undefined,
  }
}

async function requireOwner(userId: string, repositoryId: string): Promise<boolean> {
  return (await resolveRepositoryAccess(userId, repositoryId)) === 'owner'
}

/**
 * Fire-and-forget re-index, same shape as the webhook receiver's: the caller
 * gets an immediate answer and watches `syncStatus` for the outcome. Both sync
 * functions record success and failure on the row themselves, so nothing here
 * needs to await them. `agent_push` has no puller — an agent is the only thing
 * that can move its files — and never reaches this.
 */
function startSync(repo: typeof repositories.$inferSelect): void {
  const fail = (err: unknown) => console.error(`sync failed for repository ${repo.id}:`, err)
  if (repo.ingestionMethod !== 'local_path') {
    void syncGitRepository(repo.id).catch(fail)
    return
  }
  // The watcher and this pass both write `repository_files`, which is uniquely
  // indexed on (repository, path): run them at once and whichever loses the
  // insert race fails the whole sync with a duplicate-key error on a
  // repository that is perfectly fine. So the watcher stands down for the
  // pass and is re-attached after it.
  // ponytail: a repository deleted mid-pass leaves a watcher on a row that no
  // longer exists until the next restart; re-read the row here if that stops
  // being only a log line.
  stopWatchingLocalRepository(repo.id)
  void syncLocalRepository(repo.id)
    .catch(fail)
    .finally(() => {
      if (repo.localPath) watchLocalRepository(repo.id, repo.localPath)
    })
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

      // A connection that indexes nothing is indistinguishable from a broken
      // one, so the first sync starts here rather than at the poller's next
      // tick (minutes away for git) or never at all (local_path, which had no
      // caller for `startWatching` anywhere in the server before this).
      // `startSync` also leaves the folder watched from here on.
      if (ingestionMethod !== 'agent_push') startSync(repo!)

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
    // Otherwise the watcher outlives the row and keeps re-inserting files for
    // a repository nobody can reach.
    stopWatchingLocalRepository(req.params.id)
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
    Querystring: {
      types?: string
      tags?: string
      since?: string
      until?: string
      aggregate?: string
      community?: string
    }
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

  /**
   * Manual re-index (the ingestion spec's "manual-reindex", owner-only). Every
   * other trigger is on someone else's schedule — a webhook delivery, the
   * poller's tick, an agent's push — so without this there is no way to answer
   * "index it now".
   */
  app.post<{ Params: { id: string } }>('/repositories/:id/sync', async (req, reply) => {
    if (!(await requireOwner(req.user!.id, req.params.id))) {
      return reply.code(404).send({ error: 'not found' })
    }
    const repo = (await db.select().from(repositories).where(eq(repositories.id, req.params.id)))[0]!
    if (repo.ingestionMethod === 'agent_push') {
      return reply
        .code(400)
        .send({ error: 'agent-push repositories are updated by the agent, not by a sync' })
    }
    // Both sync functions bail silently on a row with no source, which would
    // strand `syncStatus` at 'syncing' forever once it is claimed below.
    if (!(repo.ingestionMethod === 'git' ? repo.gitUrl : repo.localPath)) {
      return reply.code(400).send({ error: 'this connection has no source to read' })
    }
    // Claiming the row is the 409 check: a plain read-then-dispatch lets two
    // simultaneous requests both see 'idle' and both start a clone.
    const [claimed] = await db
      .update(repositories)
      .set({ syncStatus: 'syncing' })
      .where(and(eq(repositories.id, repo.id), ne(repositories.syncStatus, 'syncing')))
      .returning()
    if (!claimed) return reply.code(409).send({ error: 'a sync is already running' })
    startSync(claimed)
    return { status: 'syncing' }
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

  app.get<{ Params: { id: string } }>(
    '/repositories/:id/graph-preference',
    async (req, reply) => {
      const access = await resolveRepositoryAccess(req.user!.id, req.params.id)
      if (!access) return reply.code(404).send({ error: 'not found' })
      const rows = await db
        .select({ include: repositoryGraphPreferences.include })
        .from(repositoryGraphPreferences)
        .where(
          and(
            eq(repositoryGraphPreferences.userId, req.user!.id),
            eq(repositoryGraphPreferences.repositoryId, req.params.id),
          ),
        )
      // No row is not an error — the column defaults to false.
      return { include: rows[0]?.include ?? false }
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
