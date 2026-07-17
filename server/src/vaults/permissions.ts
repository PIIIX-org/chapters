import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { teamMemberships, users, vaults, vaultShares } from '../db/schema.js'

export type Access = 'owner' | 'edit' | 'read'

const RANK: Record<Access, number> = { read: 1, edit: 2, owner: 3 }

export function atLeast(access: Access | null, needed: Access): boolean {
  return access !== null && RANK[access] >= RANK[needed]
}

/**
 * The access resolution rule (sub-project 1 spec): own it, direct share,
 * or team share — highest permission wins. Always resolved live; callers
 * must never cache the result across requests. Only active users have
 * any access at all.
 */
export async function resolveAccess(
  userId: string,
  vaultId: string,
): Promise<Access | null> {
  const user = (
    await db.select({ status: users.status }).from(users).where(eq(users.id, userId))
  )[0]
  if (user?.status !== 'active') return null

  const vault = (
    await db.select({ ownerId: vaults.ownerId }).from(vaults).where(eq(vaults.id, vaultId))
  )[0]
  if (!vault) return null
  if (vault.ownerId === userId) return 'owner'

  const direct = await db
    .select({ permission: vaultShares.permission })
    .from(vaultShares)
    .where(
      and(
        eq(vaultShares.vaultId, vaultId),
        eq(vaultShares.granteeType, 'user'),
        eq(vaultShares.granteeId, userId),
      ),
    )

  const viaTeam = await db
    .select({ permission: vaultShares.permission })
    .from(vaultShares)
    .innerJoin(teamMemberships, eq(teamMemberships.teamId, vaultShares.granteeId))
    .where(
      and(
        eq(vaultShares.vaultId, vaultId),
        eq(vaultShares.granteeType, 'team'),
        eq(teamMemberships.userId, userId),
      ),
    )

  const grants = [...direct, ...viaTeam].map((g) => g.permission)
  if (grants.includes('edit')) return 'edit'
  if (grants.includes('read')) return 'read'
  return null
}

/** Every vault the user can currently reach, with their effective access. */
export async function listAccessibleVaults(
  userId: string,
): Promise<Array<{ id: string; name: string; ownerId: string; mergeable: boolean; access: Access }>> {
  const user = (
    await db.select({ status: users.status }).from(users).where(eq(users.id, userId))
  )[0]
  if (user?.status !== 'active') return []

  const owned = await db.select().from(vaults).where(eq(vaults.ownerId, userId))

  const direct = await db
    .select({ vault: vaults, permission: vaultShares.permission })
    .from(vaultShares)
    .innerJoin(vaults, eq(vaults.id, vaultShares.vaultId))
    .where(and(eq(vaultShares.granteeType, 'user'), eq(vaultShares.granteeId, userId)))

  const viaTeam = await db
    .select({ vault: vaults, permission: vaultShares.permission })
    .from(vaultShares)
    .innerJoin(vaults, eq(vaults.id, vaultShares.vaultId))
    .innerJoin(teamMemberships, eq(teamMemberships.teamId, vaultShares.granteeId))
    .where(and(eq(vaultShares.granteeType, 'team'), eq(teamMemberships.userId, userId)))

  const byId = new Map<string, { id: string; name: string; ownerId: string; mergeable: boolean; access: Access }>()
  for (const v of owned) {
    byId.set(v.id, { id: v.id, name: v.name, ownerId: v.ownerId, mergeable: v.mergeable, access: 'owner' })
  }
  for (const { vault, permission } of [...direct, ...viaTeam]) {
    const existing = byId.get(vault.id)
    if (existing && RANK[existing.access] >= RANK[permission]) continue
    byId.set(vault.id, {
      id: vault.id,
      name: vault.name,
      ownerId: vault.ownerId,
      mergeable: vault.mergeable,
      access: permission,
    })
  }
  return [...byId.values()]
}

/** Every user who can currently reach the vault (owner, direct, via team). */
export async function listUsersWithAccess(vaultId: string): Promise<string[]> {
  const vault = (
    await db.select({ ownerId: vaults.ownerId }).from(vaults).where(eq(vaults.id, vaultId))
  )[0]
  if (!vault) return []
  const direct = await db
    .select({ userId: vaultShares.granteeId })
    .from(vaultShares)
    .where(and(eq(vaultShares.vaultId, vaultId), eq(vaultShares.granteeType, 'user')))
  const viaTeam = await db
    .select({ userId: teamMemberships.userId })
    .from(vaultShares)
    .innerJoin(teamMemberships, eq(teamMemberships.teamId, vaultShares.granteeId))
    .where(and(eq(vaultShares.vaultId, vaultId), eq(vaultShares.granteeType, 'team')))
  return [...new Set([vault.ownerId, ...direct.map((d) => d.userId), ...viaTeam.map((t) => t.userId)])]
}
