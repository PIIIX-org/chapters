import { and, eq } from 'drizzle-orm'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { repositories, repositoryShares, teamMemberships, users } from '../db/schema.js'

export type RepoAccess = 'owner' | 'viewer'

/**
 * Two-tier version of resolveAccess (vaults/permissions.ts): own it,
 * direct share, or team share — no edit tier, nothing here is ever
 * written to. Live-resolved on every call, active users only.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function resolveRepositoryAccess(
  userId: string,
  repositoryId: string,
): Promise<RepoAccess | null> {
  if (!UUID_REGEX.test(userId) || !UUID_REGEX.test(repositoryId)) return null
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

/**
 * The remote with anything that could be a credential taken off it:
 * `https://chapters:ghp_token@github.com/o/r.git` and `git@github.com:o/r.git`
 * both become `https://github.com/o/r.git`. Host, owner and name are what a
 * deep link is built from and are not secret — the userinfo is the only part
 * of a remote that ever is.
 *
 * Returns null for anything that does not parse, because a half-understood
 * remote handed to a link builder is a guess, and a viewer simply gets no
 * button.
 */
export function publicGitUrl(gitUrl: string | null): string | null {
  if (!gitUrl) return null
  // scp-style (`user@host:owner/repo.git`), which is not a URL at all.
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(gitUrl)
  if (scp) return `https://${scp[1]}/${scp[2]}`
  try {
    const url = new URL(gitUrl)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    url.password = ''
    url.username = ''
    return url.toString()
  } catch {
    return null
  }
}

const BLOCKED_HOSTNAMES = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'instance-data',
])

function isPrivateIp(ip: string): boolean {
  if (ip.startsWith('127.') || ip === '::1' || ip === '0.0.0.0') return true
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true
  if (ip.startsWith('169.254.')) return true
  const m = /^172\.(\d+)\./.exec(ip)
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true
  return false
}

export function isSafeGitUrl(gitUrl: string): boolean {
  if (!gitUrl || typeof gitUrl !== 'string') return false
  if (/[\r\n\0]/.test(gitUrl)) return false
  const trimmed = gitUrl.trim()
  if (trimmed.startsWith('-') || /\s/.test(trimmed)) return false

  if (config.isTest && trimmed.startsWith('file://')) {
    return true
  }

  // scp-style (`user@host:owner/repo.git`)
  const scp = /^[^@/\s]+@([a-zA-Z0-9.-]+):([a-zA-Z0-9._\/-]+)$/.exec(trimmed)
  if (scp) {
    const host = scp[1]?.toLowerCase()
    if (!host || BLOCKED_HOSTNAMES.has(host)) return false
    if (config.isProd && (host === 'localhost' || isPrivateIp(host))) return false
    return true
  }

  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:' && parsed.protocol !== 'ssh:') {
      return false
    }
    const host = parsed.hostname.toLowerCase()
    if (!host || BLOCKED_HOSTNAMES.has(host)) return false
    if (config.isProd && (host === 'localhost' || isPrivateIp(host))) return false
    return true
  } catch {
    return false
  }
}

export interface RepositoryFields {
  id: string
  name: string
  ownerId: string
  ingestionMethod: string
  gitUrl: string | null
  localPath: string | null
  defaultBranch: string | null
  mergeable: boolean
  syncStatus: string
  lastSyncedAt: Date | null
  lastSyncError: string | null
  lastWebhookAt: Date | null
  /**
   * Derived, never stored: true exactly when a secret is on disk to verify a
   * delivery against. A column set when the owner *intends* a webhook would
   * make the card claim deliveries are verifiable when nothing can verify them.
   */
  webhookConfigured: boolean
  createdAt: Date
}

/**
 * The whole repository row minus the two encrypted credentials, which are
 * write-only, and minus the owner-tier configuration when the caller is only
 * a viewer: `localPath` is a path on the server's own filesystem, and a
 * `gitUrl` can carry a credential in its userinfo
 * (`https://user:token@host/…`), which is why it is accepted once and never
 * echoed back.
 *
 * A viewer gets `localPath: null` and the *sanitized* remote rather than
 * nothing at all. Redacting `gitUrl` outright closed the credential leak and
 * silently took "Open on GitHub" away from every viewer with it: the deep
 * link keys off `ingestionMethod`, so a git-sourced repository is supposed to
 * have one for anyone who can read the code. `publicGitUrl` keeps the half a
 * link needs (host/owner/name) and drops the half that is a secret.
 *
 * Redacted to null rather than omitted: the client reads `gitUrl === null` as
 * "nothing to deep-link to" (`gitHubFileUrl`), and an absent key is what made
 * `syncHealth` mistake a never-synced repository for an empty one.
 *
 * `access` defaults to owner because every single-row caller is already
 * owner-gated (POST /repositories creates it; PATCH /repositories/:id goes
 * through requireOwner); the multi-row path below passes the tier it resolved.
 */
export function repositoryFields(
  r: typeof repositories.$inferSelect,
  access: RepoAccess = 'owner',
): RepositoryFields {
  const isOwner = access === 'owner'
  return {
    id: r.id,
    name: r.name,
    ownerId: r.ownerId,
    ingestionMethod: r.ingestionMethod,
    gitUrl: isOwner ? r.gitUrl : publicGitUrl(r.gitUrl),
    localPath: isOwner ? r.localPath : null,
    defaultBranch: r.defaultBranch,
    mergeable: r.mergeable,
    syncStatus: r.syncStatus,
    lastSyncedAt: r.lastSyncedAt,
    lastSyncError: r.lastSyncError,
    lastWebhookAt: r.lastWebhookAt,
    webhookConfigured: r.webhookSecretEncrypted !== null,
    createdAt: r.createdAt,
  }
}

export interface AccessibleRepository extends RepositoryFields {
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
    byId.set(r.id, { ...repositoryFields(r, 'owner'), access: 'owner' })
  }
  for (const { repo } of [...direct, ...viaTeam]) {
    // Owned rows are already in, so anything reached through a share here is
    // reached as a viewer — and is redacted accordingly.
    if (byId.has(repo.id)) continue
    byId.set(repo.id, { ...repositoryFields(repo, 'viewer'), access: 'viewer' })
  }
  return [...byId.values()]
}
