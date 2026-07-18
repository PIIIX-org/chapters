import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { repositories, repositoryShares, teamMemberships, users } from '../db/schema.js'

export type RepoAccess = 'owner' | 'viewer'

/**
 * Two-tier version of resolveAccess (vaults/permissions.ts): own it,
 * direct share, or team share — no edit tier, nothing here is ever
 * written to. Live-resolved on every call, active users only.
 */
export async function resolveRepositoryAccess(
  userId: string,
  repositoryId: string,
): Promise<RepoAccess | null> {
  const user = (
    await db.select({ status: users.status }).from(users).where(eq(users.id, userId))
  )[0]
  if (user?.status !== 'active') return null

  const repo = (
    await db
      .select({ ownerId: repositories.ownerId })
      .from(repositories)
      .where(eq(repositories.id, repositoryId))
  )[0]
  if (!repo) return null
  if (repo.ownerId === userId) return 'owner'

  const direct = await db
    .select({ id: repositoryShares.id })
    .from(repositoryShares)
    .where(
      and(
        eq(repositoryShares.repositoryId, repositoryId),
        eq(repositoryShares.granteeType, 'user'),
        eq(repositoryShares.granteeId, userId),
      ),
    )
    .limit(1)
  if (direct.length > 0) return 'viewer'

  const viaTeam = await db
    .select({ id: repositoryShares.id })
    .from(repositoryShares)
    .innerJoin(teamMemberships, eq(teamMemberships.teamId, repositoryShares.granteeId))
    .where(
      and(
        eq(repositoryShares.repositoryId, repositoryId),
        eq(repositoryShares.granteeType, 'team'),
        eq(teamMemberships.userId, userId),
      ),
    )
    .limit(1)
  return viaTeam.length > 0 ? 'viewer' : null
}

export interface AccessibleRepository {
  id: string
  name: string
  ownerId: string
  mergeable: boolean
  ingestionMethod: string
  syncStatus: string
  access: RepoAccess
}

export async function listAccessibleRepositories(userId: string): Promise<AccessibleRepository[]> {
  const user = (
    await db.select({ status: users.status }).from(users).where(eq(users.id, userId))
  )[0]
  if (user?.status !== 'active') return []

  const owned = await db.select().from(repositories).where(eq(repositories.ownerId, userId))

  const direct = await db
    .select({ repo: repositories })
    .from(repositoryShares)
    .innerJoin(repositories, eq(repositories.id, repositoryShares.repositoryId))
    .where(and(eq(repositoryShares.granteeType, 'user'), eq(repositoryShares.granteeId, userId)))

  const viaTeam = await db
    .select({ repo: repositories })
    .from(repositoryShares)
    .innerJoin(repositories, eq(repositories.id, repositoryShares.repositoryId))
    .innerJoin(teamMemberships, eq(teamMemberships.teamId, repositoryShares.granteeId))
    .where(and(eq(repositoryShares.granteeType, 'team'), eq(teamMemberships.userId, userId)))

  const byId = new Map<string, AccessibleRepository>()
  for (const r of owned) {
    byId.set(r.id, {
      id: r.id,
      name: r.name,
      ownerId: r.ownerId,
      mergeable: r.mergeable,
      ingestionMethod: r.ingestionMethod,
      syncStatus: r.syncStatus,
      access: 'owner',
    })
  }
  for (const { repo } of [...direct, ...viaTeam]) {
    if (byId.has(repo.id)) continue
    byId.set(repo.id, {
      id: repo.id,
      name: repo.name,
      ownerId: repo.ownerId,
      mergeable: repo.mergeable,
      ingestionMethod: repo.ingestionMethod,
      syncStatus: repo.syncStatus,
      access: 'viewer',
    })
  }
  return [...byId.values()]
}
