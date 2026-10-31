import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { repositories } from '../db/schema.js'
import { decryptCredential } from './credentials.js'
import { summarizeSkips } from './fs-scan.js'
import {
  fetchIntoMirror,
  markMirrorSynced,
  mirrorHasCommit,
  objectFormatOf,
  openMirror,
  remoteHead,
  scanMirrorTree,
  withMirrorLock,
  type RemoteHead,
} from './git-mirror.js'
import { authenticatedUrl, redactGitSecrets, splitGitUrlCredential } from './git-remote.js'
import { isSafeGitUrl } from './permissions.js'
import { listRepositoryFiles, syncRepositoryFiles } from './store.js'
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
 * Git URL ingestion (spec 8, #684): an unchanged remote HEAD costs one
 * `ls-remote` and nothing else. A moved one is fetched at depth 1 into the
 * repository's persistent mirror (git-mirror.ts), and only the files whose
 * blob differs from the last synced commit are read and handed to the store,
 * whose content-hash skip is the last guard against re-extracting a file.
 * Force-pushes and default-branch switches need no special case: the diff is
 * between two trees, whatever their ancestry.
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

  // A row the boot scrub could not encrypt still holds its credential in the
  // URL, and fetches with it: redact that one too (#593).
  const urlCredential = splitGitUrlCredential(repo.gitUrl).credential
  let credential: string | null = null
  try {
    credential = repo.gitCredentialEncrypted
      ? decryptCredential(repo.gitCredentialEncrypted)
      : null
    const cloneUrl = authenticatedUrl(repo.gitUrl, credential)

    // ponytail: check the remote HEAD commit via ls-remote before fetching (INGEST-05).
    let remote: RemoteHead | null = null
    try {
      remote = await remoteHead(cloneUrl)
      // A row with no skip report was last synced before #465 indexed every
      // tracked file: sync once more so a committed build/ shows up.
      if (remote && repo.lastSyncedCommit && remote.commit === repo.lastSyncedCommit && repo.skippedFiles) {
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
        `[git-sync] listRemote check failed, falling back to fetch: ${redactGitSecrets(detail, [credential, urlCredential])}`,
      )
    }

    const synced = await withMirrorLock(repositoryId, async () => {
      // Read again under the lock: an overlapping sync may have indexed a
      // newer commit (the diff base), or a delete removed the row (its
      // mirror goes after this, and none may be created again).
      const current = (await db.select().from(repositories).where(eq(repositories.id, repositoryId)))[0]
      if (!current) return false
      const dir = await openMirror(repositoryId, remote ? objectFormatOf(remote.commit) : null)
      const headCommit = await fetchIntoMirror(dir, cloneUrl, remote?.branch ?? null)
      // A row with no skip report predates #465 (see above): read every file once.
      const previous =
        current.lastSyncedCommit && current.skippedFiles && (await mirrorHasCommit(dir, current.lastSyncedCommit))
          ? current.lastSyncedCommit
          : null
      const indexedPaths = previous
        ? new Set((await listRepositoryFiles(repositoryId)).map((f) => f.path))
        : new Set<string>()
      // Every tracked file is source (#465, D12): no ignore rules, only .git,
      // binaries, size and the file cap. Skipped files leave currentPaths, so
      // a stale row goes (#923).
      const { files, currentPaths, skipped } = await scanMirrorTree(dir, headCommit, previous, indexedPaths)
      // The index is the fetched commit's files: its commit is recorded with them (#471).
      await syncRepositoryFiles(repositoryId, files, currentPaths, { commit: headCommit })

      await db
        .update(repositories)
        .set({
          syncStatus: 'idle',
          lastSyncedAt: new Date(),
          lastSyncError: null,
          // Without ls-remote's answer the branch name is unknown: keep the last one.
          ...(remote?.branch ? { defaultBranch: remote.branch } : {}),
          skippedFiles: summarizeSkips(skipped),
        })
        .where(eq(repositories.id, repositoryId))
      // After the row: the sync is done; recording the diff base and gc are
      // upkeep, and a failure there is logged, never a failed sync.
      await markMirrorSynced(dir, headCommit)
      return true
    })
    if (synced) recordJob('sync', 'ok', repositoryId)
  } catch (err) {
    // The raw message can carry the authenticated clone URL, and lastSyncError
    // is served to every viewer: store and rethrow only the redacted text (#383).
    const raw = err instanceof Error ? err.message : String(err)
    const errorMsg = redactGitSecrets(raw, [credential, urlCredential]).replace(/\0/g, '')
    // New or repeat (#705, #775): see recordSyncFailure.
    await recordSyncFailure(repositoryId, err, errorMsg)
    throw new Error(errorMsg)
  }
}
