import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { simpleGit } from 'simple-git'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { repositories } from '../db/schema.js'
import { decryptCredential } from './credentials.js'
import { scanRepository, summarizeSkips } from './fs-scan.js'
import { authenticatedUrl, redactGitSecrets, splitGitUrlCredential } from './git-remote.js'
import { isSafeGitUrl } from './permissions.js'
import { syncRepositoryFiles } from './store.js'
import { recordJob } from '../monitoring/metrics.js'

export type RepositorySyncStatus = (typeof repositories.$inferSelect)['syncStatus']

/**
 * Records a failed sync of a git or local-folder repository: counts it, then
 * puts the row in `error` with the (already redacted) `message`.
 *
 * A repository that is already failing (a dead remote the poller retries every
 * POLL_INTERVAL_MS, a user or agent retrying by hand) failing again is not a
 * new failure: one report on the transition into `error`, not one alert per
 * retry (#705). The transition is `lastSyncError` going from null to a
 * message, taken with one conditional update. Only syncs write that column (a
 * success clears it, a failure sets it); the `syncing` claims of the manual
 * sync route, MCP `sync_repository` and of a sync itself leave it alone. So
 * however many syncs of one repository overlap (a poll and a webhook
 * delivery), exactly one failure per transition counts as new (#775).
 * Counted before `syncStatus` reads `error`, so whoever sees `error` sees
 * the count.
 */
export async function recordSyncFailure(repositoryId: string, error: unknown, message: string): Promise<void> {
  const entered = await db
    .update(repositories)
    .set({ lastSyncError: message })
    .where(and(eq(repositories.id, repositoryId), isNull(repositories.lastSyncError)))
    .returning({ id: repositories.id })
  recordJob('sync', { error, repeat: entered.length === 0 }, repositoryId)
  await db
    .update(repositories)
    .set({ syncStatus: 'error', lastSyncError: message })
    .where(eq(repositories.id, repositoryId))
}

/**
 * Git URL ingestion (spec 8): a fresh shallow clone (depth 1, no
 * history) into a scratch temp directory on every sync — simpler and
 * more robust than reusing/fetching into a persistent working copy, at
 * the cost of a full re-clone each time. The clone is discarded after
 * its tree is read; only the extracted file content is durable.
 */
export async function syncGitRepository(repositoryId: string): Promise<void> {
  const repo = (await db.select().from(repositories).where(eq(repositories.id, repositoryId)))[0]
  if (!repo || repo.ingestionMethod !== 'git' || !repo.gitUrl) return

  if (!isSafeGitUrl(repo.gitUrl)) {
    await recordSyncFailure(repositoryId, { name: 'UnsafeGitUrl' }, 'Invalid or forbidden git clone URL')
    return
  }

  await db
    .update(repositories)
    .set({ syncStatus: 'syncing' })
    .where(eq(repositories.id, repositoryId))

  const workDir = join(tmpdir(), 'elara-repo-clones', randomBytes(8).toString('hex'))
  // A row the boot scrub could not encrypt still holds its credential in the
  // URL, and clones with it: redact that one too (#593).
  const urlCredential = splitGitUrlCredential(repo.gitUrl).credential
  let credential: string | null = null
  try {
    credential = repo.gitCredentialEncrypted
      ? decryptCredential(repo.gitCredentialEncrypted)
      : null
    const cloneUrl = authenticatedUrl(repo.gitUrl, credential)

    // ponytail: check remote HEAD commit via ls-remote before expensive full shallow clone (INGEST-05).
    try {
      const lsRemote = await simpleGit({ timeout: { block: 30_000 } }).listRemote([cloneUrl, 'HEAD'])
      const remoteCommit = lsRemote ? lsRemote.trim().split(/\s+/)[0] : null
      // A row with no skip report was last synced before #465 indexed every
      // tracked file: clone once more so a committed build/ shows up.
      if (remoteCommit && repo.lastSyncedCommit && remoteCommit === repo.lastSyncedCommit && repo.skippedFiles) {
        await db
          .update(repositories)
          .set({
            syncStatus: 'idle',
            lastSyncedAt: new Date(),
            lastSyncError: null,
          })
          .where(eq(repositories.id, repositoryId))
        recordJob('sync', 'ok', repositoryId)
        return
      }
    } catch (lsErr) {
      // git errors can echo the authenticated clone URL (#383).
      const detail = lsErr instanceof Error ? lsErr.message : String(lsErr)
      console.warn(
        `[git-sync] listRemote check failed, falling back to clone: ${redactGitSecrets(detail, [credential, urlCredential])}`,
      )
    }

    await simpleGit({ timeout: { block: 300_000 } }).clone(cloneUrl, workDir, ['--depth', '1'])

    // A depth-1 clone checks out the remote's default branch, so the name of
    // the clone's HEAD *is* the default branch — no extra network call.
    const defaultBranch = (await simpleGit(workDir).revparse(['--abbrev-ref', 'HEAD'])).trim()
    const headCommit = (await simpleGit(workDir).revparse(['HEAD'])).trim()

    // A clone holds only tracked files, and every tracked file is source
    // (#465, D12): no ignore rules, only .git, binaries, size and the file cap.
    // Skipped files leave currentPaths, so a stale row goes (#923).
    const { files, currentPaths, skipped } = await scanRepository(workDir, null, 'git-sync')
    // The index is HEAD's files: its commit is recorded with them (#471).
    await syncRepositoryFiles(repositoryId, files, currentPaths, { commit: headCommit })

    await db
      .update(repositories)
      .set({
        syncStatus: 'idle',
        lastSyncedAt: new Date(),
        lastSyncError: null,
        defaultBranch,
        skippedFiles: summarizeSkips(skipped),
      })
      .where(eq(repositories.id, repositoryId))
    recordJob('sync', 'ok', repositoryId)
  } catch (err) {
    // The raw message can carry the authenticated clone URL, and lastSyncError
    // is served to every viewer: store and rethrow only the redacted text (#383).
    const raw = err instanceof Error ? err.message : String(err)
    const errorMsg = redactGitSecrets(raw, [credential, urlCredential]).replace(/\0/g, '')
    // New or repeat (#705, #775): see recordSyncFailure.
    await recordSyncFailure(repositoryId, err, errorMsg)
    throw new Error(errorMsg)
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}
