import { relative } from 'node:path'
import chokidar from 'chokidar'

// ponytail: hardcoded ignore list, not full .gitignore parsing — covers
// the overwhelming common case (vendored deps, git internals) cheaply.
export const IGNORED = /(^|\/)(\.git|node_modules)(\/|$)/

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
  const runSync = () => {
    void onChange().catch((err: unknown) => {
      console.error(`[local-watch] sync failed for repository ${repositoryId}:`, err)
    })
  }

  const watcher = chokidar.watch(localPath, {
    ignored: (path) => IGNORED.test(relative(localPath, path)),
    ignoreInitial: false,
  })
  watcher.on('all', () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(runSync, DEBOUNCE_MS)
  })

  return () => {
    if (timer) clearTimeout(timer)
    void watcher.close()
  }
}
