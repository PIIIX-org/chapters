import { and, eq, ne } from 'drizzle-orm'
import { simpleGit } from 'simple-git'
import { db } from '../db/client.js'
import { repositories } from '../db/schema.js'
import { recordSyncFailure, syncGitRepository, type RepositorySyncStatus } from './git-sync.js'
import { GitignoreRules, scanRepository, summarizeSkips } from './fs-scan.js'
import { startWatching } from './local-watch.js'
import { syncRepositoryFiles } from './store.js'
import { recordJob } from '../monitoring/metrics.js'

/**
 * Pure decision function (unit-tested directly): poll unless a webhook
 * arrived within `thresholdMs` (WEBHOOK_STALE_THRESHOLD_MS) and the sync it
 * triggered did not fail. A repository without a webhook, with a stale one,
 * or in `error` is polled every tick, so a hook that stops delivering never
 * stops the repository updating for longer than the threshold plus one poll
 * interval (#410).
 *
 * `lastSyncedAt` deliberately plays no part: the webhook route writes
 * `lastWebhookAt` before its sync and the sync writes `lastSyncedAt` after,
 * so "synced since the last webhook" holds after every successful webhook
 * sync and once disabled polling for good.
 */
export function shouldPoll(
  lastWebhookAt: Date | null,
  syncStatus: RepositorySyncStatus,
  now: Date,
  thresholdMs: number,
): boolean {
  if (!lastWebhookAt || syncStatus === 'error') return true
  return now.getTime() - lastWebhookAt.getTime() > thresholdMs
}

/**
 * Boot pass: if the server was restarted or crashed while a repository was
 * syncing, its row in Postgres was left as `syncStatus = 'syncing'`.
 * Without this pass, that row stays locked in 'syncing' forever: the UI spins,
 * the poller skips it, and manual/MCP sync requests get rejected with 409
 * Conflict ("a sync is already running").
 *
 * This reconciles any stranded 'syncing' state:
 * - Repositories with a previous successful sync (`lastSyncedAt != null`) are
 *   restored to `syncStatus = 'idle'`.
 * - Repositories that were interrupted during their very first sync
 *   (`lastSyncedAt == null`) are set to `syncStatus = 'error'` with
 *   `lastSyncError = 'Sync interrupted by server restart before initial completion'`.
 *
 * Returns the count of reconciled repositories.
 */
export async function reconcileOrphanedSyncs(): Promise<number> {
  const stranded = await db
    .select()
    .from(repositories)
    .where(eq(repositories.syncStatus, 'syncing'))

  for (const repo of stranded) {
    if (repo.lastSyncedAt) {
      await db
        .update(repositories)
        .set({ syncStatus: 'idle', lastSyncError: null })
        .where(eq(repositories.id, repo.id))
    } else {
      await db
        .update(repositories)
        .set({
          syncStatus: 'error',
          lastSyncError: 'Sync interrupted by server restart before initial completion',
        })
        .where(eq(repositories.id, repo.id))
    }
  }

  return stranded.length
}

/** Fallback freshness for git repositories a webhook can't reach (spec 8). */
export function startPollingScheduler(intervalMs: number, thresholdMs: number): () => void {
  const timer = setInterval(() => {
    void tick(thresholdMs)
  }, intervalMs)
  return () => clearInterval(timer)
}

async function tick(thresholdMs: number): Promise<void> {
  const candidates = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ingestionMethod, 'git'), ne(repositories.syncStatus, 'syncing')))

  const now = new Date()
  for (const repo of candidates) {
    if (!shouldPoll(repo.lastWebhookAt, repo.syncStatus, now, thresholdMs)) continue
    try {
      await syncGitRepository(repo.id)
    } catch (err) {
      console.error(`polling sync failed for repository ${repo.id}:`, err)
    }
  }
}

// ---------------------------------------------------------------------------
// local_path ingestion (spec 8). Until this existed, `startWatching` had no
// caller anywhere in `server/src`: a folder repository was connected and then
// stayed empty forever, while the connect dialog promised Chapters was
// watching it. The watchers below are what make that promise true.
// ---------------------------------------------------------------------------

/** repositoryId → the watcher's stop(). Process-local, rebuilt at boot. */
const watchers = new Map<string, () => void>()

/**
 * The commit a folder's indexed files are (#471): HEAD when the folder is in
 * a git work tree with nothing uncommitted under it and every indexed path
 * tracked, else null (no git, no commit yet, or the index differs: answers
 * then name the tree hash). `git status` alone is not enough: it hides
 * untracked files that rules the scan never reads ignore (a parent folder's
 * `.gitignore`, the repository's `info/exclude` when the folder is a
 * subfolder, `core.excludesFile`), and the scan indexes them. Listing the
 * tracked paths reads git's index, unlike listing every untracked file,
 * which walks ignored trees such as `node_modules`. Git's own checks stand:
 * a folder owned by another user (`safe.directory`) gives null.
 * `--no-optional-locks` keeps status from rewriting the user's index.
 */
async function cleanWorkTreeCommit(root: string, indexedPaths: string[]): Promise<string | null> {
  try {
    const git = simpleGit(root)
    if ((await git.revparse(['--is-inside-work-tree'])).trim() !== 'true') return null
    const changes = await git.raw(['--no-optional-locks', 'status', '--porcelain', '--ignore-submodules=all', '--', '.'])
    if (changes.trim() !== '') return null
    // Relative to the folder, as the scan's paths are.
    const tracked = new Set((await git.raw(['ls-files', '-z', '--', '.'])).split('\0'))
    if (!indexedPaths.every((path) => tracked.has(path))) return null
    return (await git.revparse(['HEAD'])).trim()
  } catch {
    return null
  }
}

/**
 * One status-tracked pass over a folder — the local twin of
 * `syncGitRepository`. The watcher keeps content current but reports nothing;
 * this is what writes `syncStatus`/`lastSyncedAt`/`lastSyncError`, so a
 * freshly connected folder reads as "synced, N files" instead of "never
 * synced".
 */
export async function syncLocalRepository(repositoryId: string): Promise<void> {
  const repo = (await db.select().from(repositories).where(eq(repositories.id, repositoryId)))[0]
  if (!repo || repo.ingestionMethod !== 'local_path' || !repo.localPath) return
  const root = repo.localPath

  await db.update(repositories).set({ syncStatus: 'syncing' }).where(eq(repositories.id, repositoryId))
  try {
    // A folder follows its .gitignore files (#465, D12). Skipped files leave
    // currentPaths, so a stale row goes (#923).
    const { files, currentPaths, skipped } = await scanRepository(root, new GitignoreRules(root), 'scheduler')
    // After the scan, against what it indexed; an edit since then changes
    // the folder, so the watcher syncs again and records the version afresh.
    const commit = await cleanWorkTreeCommit(root, currentPaths)
    await syncRepositoryFiles(repositoryId, files, currentPaths, { commit })
    await db
      .update(repositories)
      .set({
        syncStatus: 'idle',
        lastSyncedAt: new Date(),
        lastSyncError: null,
        skippedFiles: summarizeSkips(skipped),
      })
      .where(eq(repositories.id, repositoryId))
    recordJob('sync', 'ok', repositoryId)
  } catch (err) {
    // New or repeat: as for git (recordSyncFailure, #705, #775).
    await recordSyncFailure(repositoryId, err, (err as Error).message.replace(/\0/g, ''))
    throw err
  }
}

/** Starts (or restarts) the folder watcher for one repository. */
export function watchLocalRepository(repositoryId: string, localPath: string): void {
  watchers.get(repositoryId)?.()
  watchers.set(
    repositoryId,
    startWatching(repositoryId, localPath, () => syncLocalRepository(repositoryId)),
  )
}

/** Stops and forgets a repository's watcher. Safe to call for one that has none. */
export function stopWatchingLocalRepository(repositoryId: string): void {
  watchers.get(repositoryId)?.()
  watchers.delete(repositoryId)
}

/**
 * Boot pass: watchers live in process memory, so every local_path repository
 * needs one re-attached on every start. Returns how many were started.
 */
export async function startLocalWatchers(): Promise<number> {
  const rows = await db
    .select()
    .from(repositories)
    .where(eq(repositories.ingestionMethod, 'local_path'))
  for (const repo of rows) {
    if (repo.localPath) watchLocalRepository(repo.id, repo.localPath)
  }
  return watchers.size
}
