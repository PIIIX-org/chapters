import { apiFetch } from '../lib/api.js'

/**
 * Repositories — read-only by design
 * (`2026-07-18-repository-ingestion-design.md`). Nothing in this module
 * writes file content, because no endpoint behind it accepts one: code is
 * a derived index, git remains the record of truth. There is deliberately
 * no update-file, no revert and no trash here.
 *
 * The shapes below are the unit 7 contract. Two of them depend on backend
 * additions specified in
 * `docs/superpowers/plans/2026-08-25-unit-7-repositories.md`:
 * `defaultBranch` on the repository (addition 4) and
 * `GET /repositories/:id/files/content` (addition 3).
 */

export type IngestionMethod = 'git' | 'local_path' | 'agent_push'
export type SyncStatus = 'idle' | 'syncing' | 'error'
export type RepositoryAccess = 'owner' | 'viewer'

export interface Repository {
  id: string
  name: string
  ownerId: string
  ingestionMethod: IngestionMethod
  /** Non-null only for `git`. The one input "open on GitHub" is derived from. */
  gitUrl: string | null
  /** Non-null only for `local_path`, already resolved under the allowlisted root. */
  localPath: string | null
  /** Addition 4. Null until the first git sync reads it; never set for the other two methods. */
  defaultBranch: string | null
  mergeable: boolean
  syncStatus: SyncStatus
  /** Null means never synced — distinct from synced-and-empty. See `syncHealth`. */
  lastSyncedAt: string | null
  lastSyncError: string | null
  /** Last verified webhook delivery. Null on a git repo means the poller is carrying it. */
  lastWebhookAt: string | null
  /** Whether a webhook secret exists. The secret itself is never served after creation. */
  webhookConfigured: boolean
  createdAt: string
}

export interface AccessibleRepository extends Repository {
  access: RepositoryAccess
}

export interface RepositoryFile {
  id: string
  path: string
  language: string | null
  size: number
  updatedAt: string
}

/** A file's declared top-level symbols — the outline (spec 9). Never graph nodes. */
export interface FileSymbol {
  name: string
  kind: string
  startLine: number
  endLine: number
}

export interface RepositoryFileContent extends RepositoryFile {
  content: string
  contentHash: string
  sourceModifiedAt: string | null
  /** Served with the content so the outline costs no second request. */
  symbols: FileSymbol[]
}

export interface RepositoryShareMember {
  teamId: string
  userId: string
  email: string
}

/**
 * No permission field, unlike `Share`: a repository grant is binary, because
 * nothing is editable. Owner-only to grant or revoke.
 */
export interface RepositoryShare {
  id: string
  repositoryId: string
  granteeType: 'user' | 'team'
  granteeId: string
  createdAt: string
  members?: RepositoryShareMember[]
}

export interface SyncToken {
  id: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

/** Shown exactly once, like an MCP token — the server stores it encrypted. */
export interface WebhookSecret {
  secret: string
  /** Paste this, and the secret, into the git host's webhook settings. */
  webhookPath: string
}

/** The three connect-flow branches, each carrying only its own fields. */
export type CreateRepositoryInput =
  | { name: string; ingestionMethod: 'git'; gitUrl: string; gitCredential?: string }
  | { name: string; ingestionMethod: 'local_path'; localPath: string }
  | { name: string; ingestionMethod: 'agent_push' }

export function listRepositories(): Promise<AccessibleRepository[]> {
  return apiFetch('/repositories')
}

export function createRepository(input: CreateRepositoryInput): Promise<Repository> {
  return apiFetch('/repositories', { method: 'POST', body: JSON.stringify(input) })
}

export function updateRepository(
  id: string,
  patch: { name?: string; mergeable?: boolean },
): Promise<Repository> {
  return apiFetch(`/repositories/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
}

/**
 * Hard delete — there is no repository trash. The index is derived, so the
 * consequence to state inline is "the connection and its index are removed;
 * your code is untouched", not "this cannot be undone".
 */
export function deleteRepository(id: string): Promise<{ status: 'deleted' }> {
  return apiFetch(`/repositories/${id}`, { method: 'DELETE' })
}

/** Metadata only — no content. The tree is built client-side from these paths. */
export function listRepositoryFiles(id: string): Promise<RepositoryFile[]> {
  return apiFetch(`/repositories/${id}/files`)
}

/**
 * Addition 3. `path` is a full relative path with slashes, so it travels as a
 * query param rather than a wildcard segment — one encoding, no collision with
 * `/repositories/:id/files`.
 */
export function getRepositoryFileContent(id: string, path: string): Promise<RepositoryFileContent> {
  return apiFetch(`/repositories/${id}/files/content?path=${encodeURIComponent(path)}`)
}

export function listRepositoryShares(id: string): Promise<RepositoryShare[]> {
  return apiFetch(`/repositories/${id}/shares`)
}

export function createRepositoryShare(
  id: string,
  body: { granteeType: 'user' | 'team'; granteeId: string },
): Promise<RepositoryShare> {
  return apiFetch(`/repositories/${id}/shares`, { method: 'POST', body: JSON.stringify(body) })
}

export function revokeRepositoryShare(id: string, shareId: string): Promise<{ status: 'revoked' }> {
  return apiFetch(`/repositories/${id}/shares/${shareId}`, { method: 'DELETE' })
}

/**
 * Generates and returns a webhook secret once. Calling it again replaces the
 * previous secret, which breaks deliveries until the git host is updated —
 * say that inline before the button is pressed.
 */
export function createWebhookSecret(id: string): Promise<WebhookSecret> {
  return apiFetch(`/repositories/${id}/webhook-secret`, { method: 'POST' })
}

export function listSyncTokens(id: string): Promise<SyncToken[]> {
  return apiFetch(`/repositories/${id}/sync-tokens`)
}

/** Returned once, hashed at rest — feed it straight into `SecretReveal`. */
export function createSyncToken(id: string): Promise<{ token: string }> {
  return apiFetch(`/repositories/${id}/sync-tokens`, { method: 'POST' })
}

export function revokeSyncToken(id: string, tokenId: string): Promise<{ status: 'revoked' }> {
  return apiFetch(`/repositories/${id}/sync-tokens/${tokenId}/revoke`, { method: 'POST' })
}

export function getRepositoryGraphPreference(id: string): Promise<{ include: boolean }> {
  return apiFetch(`/repositories/${id}/graph-preference`)
}

export function setRepositoryGraphPreference(id: string, include: boolean): Promise<{ include: boolean }> {
  return apiFetch(`/repositories/${id}/graph-preference`, {
    method: 'PUT',
    body: JSON.stringify({ include }),
  })
}

export interface RemoteFileInfo {
  url: string
  label: string
  provider: 'GitHub' | 'GitLab' | 'Bitbucket' | 'Codeberg'
}

/**
 * A remote git deep link for one file, or null when there is nothing to link to.
 * Null for `local_path` and `agent_push` (no remote URL exists) and for unrecognized
 * hosts — callers render the button only when this returns a non-null info,
 * per the spec's "git-sourced only" rule.
 *
 * Supports GitHub, GitLab, Bitbucket, and Codeberg/Gitea.
 */
export function remoteFileInfo(
  repo: Pick<Repository, 'ingestionMethod' | 'gitUrl' | 'defaultBranch'>,
  path: string,
): RemoteFileInfo | null {
  if (repo.ingestionMethod !== 'git' || !repo.gitUrl) return null
  const ref = repo.defaultBranch ?? 'HEAD'
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')

  // GitHub: https://github.com/o/r(.git) or git@github.com:o/r.git
  const gh = /^(?:https?:\/\/(?:[^@/]*@)?github\.com\/|git@github\.com:)(.+?)(?:\.git)?\/?$/.exec(repo.gitUrl)
  if (gh) {
    return {
      url: `https://github.com/${gh[1]}/blob/${ref}/${encodedPath}`,
      label: 'Open on GitHub',
      provider: 'GitHub',
    }
  }

  // GitLab: https://gitlab.com/o/r(.git) or git@gitlab.com:o/r.git
  const gl = /^(?:https?:\/\/(?:[^@/]*@)?gitlab\.com\/|git@gitlab\.com:)(.+?)(?:\.git)?\/?$/.exec(repo.gitUrl)
  if (gl) {
    return {
      url: `https://gitlab.com/${gl[1]}/-/blob/${ref}/${encodedPath}`,
      label: 'Open on GitLab',
      provider: 'GitLab',
    }
  }

  // Bitbucket: https://bitbucket.org/o/r(.git) or git@bitbucket.org:o/r.git
  const bb = /^(?:https?:\/\/(?:[^@/]*@)?bitbucket\.org\/|git@bitbucket\.org:)(.+?)(?:\.git)?\/?$/.exec(repo.gitUrl)
  if (bb) {
    return {
      url: `https://bitbucket.org/${bb[1]}/src/${ref}/${encodedPath}`,
      label: 'Open on Bitbucket',
      provider: 'Bitbucket',
    }
  }

  // Codeberg: https://codeberg.org/o/r(.git) or git@codeberg.org:o/r.git
  const cb = /^(?:https?:\/\/(?:[^@/]*@)?codeberg\.org\/|git@codeberg\.org:)(.+?)(?:\.git)?\/?$/.exec(repo.gitUrl)
  if (cb) {
    return {
      url: `https://codeberg.org/${cb[1]}/src/branch/${ref}/${encodedPath}`,
      label: 'Open on Codeberg',
      provider: 'Codeberg',
    }
  }

  return null
}

export function remoteFileUrl(
  repo: Pick<Repository, 'ingestionMethod' | 'gitUrl' | 'defaultBranch'>,
  path: string,
): string | null {
  return remoteFileInfo(repo, path)?.url ?? null
}

export const gitHubFileUrl = remoteFileUrl

export type SyncHealth = 'syncing' | 'error' | 'never-synced' | 'synced-empty' | 'synced'

/**
 * "Never synced" and "synced and empty" are different facts and must read
 * differently: the first means nothing has run yet, the second means a sync
 * ran and found no indexable files (wrong path, empty branch, everything
 * ignored). `lastSyncedAt` alone separates them; `fileCount` is what makes
 * the empty case visible, and is omitted where the file list is not loaded.
 */
export function syncHealth(
  repo: Pick<Repository, 'syncStatus' | 'lastSyncedAt'>,
  fileCount?: number,
): SyncHealth {
  if (repo.syncStatus === 'syncing') return 'syncing'
  if (repo.syncStatus === 'error') return 'error'
  if (repo.lastSyncedAt === null) return 'never-synced'
  return fileCount === 0 ? 'synced-empty' : 'synced'
}
