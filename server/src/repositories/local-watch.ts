import { statSync, type Stats } from 'node:fs'
import { basename, relative } from 'node:path'
import chokidar from 'chokidar'
import { GIT_METADATA, GitignoreRules } from './fs-scan.js'

const DEBOUNCE_MS = 300

/**
 * Real-time local-path ingestion (spec 8). Returns a stop() to close the watcher.
 *
 * `onChange` does the actual sync. This file deliberately does not know how —
 * it used to run its own copy of the scan-and-store loop, which meant watcher
 * syncs never touched `syncStatus`/`lastSyncedAt`/`lastSyncError` and the card
 * kept reporting the connect-time timestamp over an index that had moved on.
 * The scheduler passes its status-tracked `syncLocalRepository` instead, so
 * there is one implementation and it is the one that reports.
 */
export function startWatching(
  repositoryId: string,
  localPath: string,
  onChange: () => Promise<void>,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null

  // The catch is load-bearing, not tidiness: this runs from a timer with no
  // caller to reject to, so an error here is an unhandled rejection, and Node
  // terminates the process on those. Since watchers are started at boot for
  // every local_path repository, one folder that has been deleted or unmounted
  // would take the whole server down on startup. The sync itself already
  // records the failure on the repository row; the watcher's job is to stay
  // alive so the next change gets another chance.
  let isSyncing = false
  let rerunRequested = false

  const runSync = async () => {
    // ponytail: re-entrancy mutex avoids parallel conflicting sync runs during rapid edits (INGEST-06).
    if (isSyncing) {
      rerunRequested = true
      return
    }
    isSyncing = true
    try {
      do {
        rerunRequested = false
        try {
          await onChange()
        } catch (err: unknown) {
          console.error(`[local-watch] sync failed for repository ${repositoryId}:`, err)
        }
      } while (rerunRequested)
    } finally {
      isSyncing = false
    }
  }

  // The same rules as the scan (#465): .git always, then the folder's
  // .gitignore files. A changed .gitignore drops the cached rules, and the
  // sync it triggers rescans with fresh ones.
  const rules = new GitignoreRules(localPath)
  const ignored = (path: string, stats?: Stats): boolean => {
    const relPath = relative(localPath, path)
    if (relPath === '' || relPath.startsWith('..')) return false
    if (GIT_METADATA.test(relPath)) return true
    let isDir = stats?.isDirectory()
    if (isDir === undefined) {
      try {
        isDir = statSync(path).isDirectory()
      } catch {
        isDir = false
      }
    }
    return rules.ignores(relPath, isDir)
  }
  const watcher = chokidar.watch(localPath, { ignored, ignoreInitial: false })
  watcher.on('all', (_event, path) => {
    if (basename(path) === '.gitignore') rules.clear()
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void runSync(), DEBOUNCE_MS)
  })

  return () => {
    if (timer) clearTimeout(timer)
    void watcher.close()
  }
}
