import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { and, eq, ne } from 'drizzle-orm'
import { db } from '../db/client.js'
import { repositories } from '../db/schema.js'
import { syncGitRepository } from './git-sync.js'
import { listFilesRecursive } from './fs-scan.js'
import { IGNORED, startWatching } from './local-watch.js'
import { syncRepositoryFiles, type FileUpdate } from './store.js'

/**
 * Pure decision function (unit-tested directly — the interval loop
 * around it isn't): poll unless a webhook has been seen recently
 * enough that the repository is already staying current on its own.
 */
export function shouldPoll(
  lastWebhookAt: Date | null,
  lastSyncedAt: Date | null,
  now: Date,
  thresholdMs: number,
): boolean {
  if (!lastWebhookAt) return true
  const webhookIsStale = now.getTime() - lastWebhookAt.getTime() > thresholdMs
  if (!webhookIsStale) return false
  // A stale webhook doesn't matter if something else (a manual/agent
  // sync) already caught the repository up more recently than that.
  return !lastSyncedAt || lastSyncedAt < lastWebhookAt
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
    if (!shouldPoll(repo.lastWebhookAt, repo.lastSyncedAt, now, thresholdMs)) continue
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
    const currentPaths = await listFilesRecursive(root, IGNORED)
    const files: FileUpdate[] = []
    for (const path of currentPaths) {
      try {
        files.push({ path, content: await readFile(join(root, path), 'utf8') })
      } catch {
        // Vanished between listing and reading — the next pass's manifest wins.
      }
    }
    await syncRepositoryFiles(repositoryId, files, currentPaths)
    await db
      .update(repositories)
      .set({ syncStatus: 'idle', lastSyncedAt: new Date(), lastSyncError: null })
      .where(eq(repositories.id, repositoryId))
  } catch (err) {
    await db
      .update(repositories)
      .set({ syncStatus: 'error', lastSyncError: (err as Error).message })
      .where(eq(repositories.id, repositoryId))
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
